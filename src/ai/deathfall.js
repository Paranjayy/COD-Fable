/**
 * AI — 死亡演出のファサード + 手続き倒れ込み (ラグドールのフォールバック)。
 *
 * ## 構図 (2026-07 のラグドール導入後)
 *
 * agent.js は従来どおり `new DeathFall(rig, bones)` を持ち、begin / update /
 * finish だけを呼ぶ。この DeathFall がファサードで、死亡時に
 *
 *   - **Havok 実ラグドール** (src/ai/ragdoll.js の RagdollFall) — 既定
 *   - **手続き倒れ込み** (このファイル下半分) — フォールバック
 *
 * のどちらかへ委譲する。手続き側へ落ちる条件:
 *
 *   1. `?ragdoll=0` (config.ragdoll === false) — 切り分け・決定性の逃げ道
 *   2. staged エージェント (キャプチャ用タブロー) — 下記 finish() の事情
 *   3. RagdollFall.begin() が throw した場合 (物理未初期化など)
 *
 * ## finish() とキャプチャの決定性
 *
 * staged の死体 (ai/index.js debugStage) は「撮影フレームまでに静止済み」で
 * ある必要があり finish() で一気に完了姿勢まで進める。ラグドールは Havok を
 * 実時間で回すしかなく finish できないため、**finish() が呼ばれたらラグドールを
 * 破棄して手続きモーションに切り替える**。これにより 11 ショットの pixel gate
 * (bit-identical) はラグドール導入前と同じ絵のまま保たれる。
 *
 * ## 手続きモーションの動き (フォールバック時)
 *
 *   0.00-0.35  膝が抜ける: 腰が沈み、脚が折れ、上体が前に落ちる
 *   0.15-1.00  倒れ込み: 足元を支点に被弾方向へ 90° 回転 (二次で加速)、
 *              着地間際に 4° のバウンドで戻って静止
 *   全区間     現在の姿勢 → 脱力ポーズへの slerp ブレンド
 *
 * ルートの回転は**アクターのルートノード**に掛ける (ボーンではなく)。倒れる
 * 軸はワールド水平の「被弾方向 × up」で、支点がアクター原点 (足元, y=0) に
 * あるため、90° 回した時点で体は地面の高さに寝る。ラグドール側はルート回転を
 * 使わず (out.rootAngle = 0)、ボーンローカルへ直接書く — ragdoll.js 参照。
 */

import { Vector3, Quaternion, Euler } from './math3.js';
import { RagdollFall } from './ragdoll.js';

const DEG = Math.PI / 180;

/**
 * 脱力ポーズ (バインドポーズからのローカル euler 差分, 度)。clips.js と同じ
 * 記法。仰向け/うつ伏せの区別はルート回転が作るので、ここは「力の抜けた
 * 手足」だけを作る。
 */
const LIMP = {
  Spine: [6, 4, 3],
  Spine1: [5, -3, 2],
  Spine2: [4, 5, -2],
  Neck: [8, 12, 4],
  Head: [10, 18, 8],
  ClavicleR: [-4, 0, 8],
  UpperArmR: [-24, 10, 26],
  ForearmR: [14, 0, 0],
  HandR: [8, 0, 10],
  ClavicleL: [-6, 0, -10],
  UpperArmL: [-30, -8, -34],
  ForearmL: [22, 0, 0],
  HandL: [10, 0, -8],
  UpLegR: [10, 6, -7],
  LegR: [-16, 0, 0],
  FootR: [18, 0, 0],
  UpLegL: [6, -8, 9],
  LegL: [-26, 0, 0],
  FootL: [22, 0, 0],
};

const DURATION = 1.15;

export class DeathFall {
  constructor(rig, bones) {
    this.rig = rig;
    this.bones = bones;
    this.t = -1; // 負 = 非アクティブ (agent.updateDead がこの符号で回す/止める)
    this.fallDir = new Vector3(0, 0, -1);
    this.axis = new Vector3(1, 0, 0);
    /** 死亡瞬間の各ボーンのローカル回転 (ここから脱力ポーズへブレンド)。 */
    this._from = [];
    this._to = [];
    for (let i = 0; i < rig.count; i++) {
      this._from.push(new Quaternion());
      this._to.push(new Quaternion());
    }
    this._q = new Quaternion();
    this._e = new Euler();
    this._groundY = 0;
    this._twist = 0;

    /** 委譲先のラグドール。null なら手続きモーションが動く。 */
    this._ragdoll = null;
    /** finish() での手続き切り替え用に begin の引数を保存 (dir はコピー)。 */
    this._savedAgent = null;
    this._savedDir = new Vector3();
    this._savedHasDir = false;

    // 脱力ポーズのローカル回転を一度だけ焼いておく
    for (let i = 0; i < rig.count; i++) {
      const d = LIMP[rig.names[i]];
      this._to[i].copy(rig.localQuat[i]);
      if (d) {
        this._e.set(d[0] * DEG, d[1] * DEG, d[2] * DEG, 'XYZ');
        this._q.setFromEuler(this._e);
        this._to[i].multiply(this._q);
      }
    }
  }

  /** 手続きモーション専用の進捗 (ラグドール委譲中は意味を持たない)。 */
  get active() {
    return this.t >= 0 && this.t < DURATION;
  }

  get done() {
    return this.t >= DURATION;
  }

  /**
   * @param agent  倒すエージェント (yaw / position / rng / phys / ctx を読む)
   * @param dir    被弾の入射方向 (省略時は正面から撃たれた扱い = 後ろへ倒れる)
   * @param groundY 支点の床高さ
   */
  begin(agent, dir, groundY) {
    if (this._useRagdoll(agent)) {
      let r = null;
      try {
        r = new RagdollFall(this.rig, this.bones);
        r.begin(agent, dir, groundY);
        this._ragdoll = r;
        this._savedAgent = agent;
        this._savedHasDir = !!dir;
        if (dir) this._savedDir.copy(dir); // dir はプール由来のことがあるためコピー
        this.t = 0;
        return;
      } catch (err) {
        // 物理未初期化・Babylon 更新での API 変化など。死亡演出が消えるよりは
        // 手続きモーションで確実に倒す。
        console.warn('[ai] ragdoll begin failed — 手続きモーションへ:', err?.message ?? err);
        r?.dispose();
        this._ragdoll = null;
      }
    }
    this._beginProcedural(agent, dir, groundY);
  }

  /** ラグドールを使うか。判断根拠は冒頭コメントの 3 条件。 */
  _useRagdoll(agent) {
    if (agent.ctx?.config?.ragdoll === false) return false; // ?ragdoll=0
    if (agent.staged) return false; // タブローは finish() 前提 (冒頭コメント)
    return !!agent.phys?.plugin;
  }

  /** 手続き倒れ込みの開始 (従来の DeathFall.begin と同一)。 */
  _beginProcedural(agent, dir, groundY) {
    this.t = 0;
    this._groundY = groundY;
    // 倒れる方向 = 入射方向の水平成分 (弾に押される向き)
    const dx = dir?.x ?? -Math.sin(agent.yaw);
    const dz = dir?.z ?? -Math.cos(agent.yaw);
    const l = Math.hypot(dx, dz);
    if (l > 1e-4) this.fallDir.set(dx / l, 0, dz / l);
    else this.fallDir.set(-Math.sin(agent.yaw), 0, -Math.cos(agent.yaw));
    // 回転軸 = up × fallDir (この軸まわりの正回転が fallDir へ倒す)
    this.axis.set(this.fallDir.z, 0, -this.fallDir.x);
    // 同じ倒れ方が二度と続かないよう、わずかなねじれを混ぜる (決定的 rng)
    this._twist = agent.rng.range(-0.35, 0.35);
    // 現在のローカル回転をキャプチャ
    for (let i = 0; i < this.rig.count; i++) this._from[i].copy(this.bones[i].quaternion);
  }

  /**
   * 1 フレーム進める。ボーンのローカル姿勢と、アクタールートに掛けるべき
   * 追加回転 (out.rootQuat)・支点の y (out.rootY) を書く。
   * @returns true = まだ動いている / false = 静止済み (以後呼ばなくてよい)
   */
  update(dt, out) {
    if (this._ragdoll) {
      if (this.t < 0) return false;
      this.t += dt; // 参考値。ラグドールの静止は RagdollFall が自分で判定する
      return this._ragdoll.update(dt, out);
    }
    if (this.t < 0) return false;
    const wasDone = this.done;
    this.t = Math.min(DURATION, this.t + dt);
    const t = this.t / DURATION;

    // --- 姿勢ブレンド -------------------------------------------------
    const w = Math.min(1, t * 1.7);
    const buckle = smooth01(Math.min(1, t / 0.35));
    for (let i = 0; i < this.rig.count; i++) {
      const b = this.bones[i];
      b.quaternion.slerpQuaternions(this._from[i], this._to[i], w);
      if (i === 0) {
        // 膝が抜けて腰が沈む (ルートボーンのローカル位置で表現)
        b.position.copy(this.rig.localPos[0]);
        b.position.y -= 0.30 * buckle;
      }
      b.updateMatrix();
    }

    // --- 倒れ込み (ルート回転) ---------------------------------------
    const fall = Math.max(0, (t - 0.13) / 0.87);
    // 二次で加速し、最後に 4° のバウンド
    let ang = 90 * fall * fall;
    if (fall > 0.9) ang = 90 - 4 * Math.sin(((fall - 0.9) / 0.1) * Math.PI);
    out.rootAngle = ang * DEG;
    out.rootAxis = this.axis;
    out.rootTwist = this._twist * smooth01(fall);
    out.rootY = this._groundY;
    return !wasDone;
  }

  /**
   * キャプチャ演出用: 一気に静止状態まで進める。
   *
   * ラグドール委譲中に呼ばれたら (staged 死体がここに来る)、ラグドールを破棄
   * して手続きモーションへ切り替えてから完了させる — Havok は「一気に進める」
   * ことができないため。rng の消費 (twist 1 回) は従来の begin と同じなので、
   * キャプチャの決定性は保たれる。
   */
  finish(out) {
    if (this._ragdoll) {
      this._ragdoll.dispose();
      this._ragdoll = null;
      this._beginProcedural(
        this._savedAgent,
        this._savedHasDir ? this._savedDir : null,
        this._savedAgent?.position?.y ?? 0
      );
    }
    if (this.t < 0) return;
    this.t = DURATION - 1e-4;
    this.update(1, out);
  }

  /**
   * ラグドールのボディ/拘束を Havok から回収する。AiSystem.dispose と
   * _clearStage が呼ぶ (agent.dispose はこのクラスを知らない — agent.js を
   * 触らないための設計)。手続きモーションのみなら no-op。
   */
  dispose() {
    this._ragdoll?.dispose();
    this._ragdoll = null;
  }
}

function smooth01(x) {
  return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}
