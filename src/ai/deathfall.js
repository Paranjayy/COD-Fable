/**
 * AI — 手続き的な死亡モーション (ラグドールの代替)。
 *
 * ## なぜラグドールではないのか
 *
 * Three 版は physics の自前ラグドールソルバ (particle + constraint) に生きた
 * スケルトンを渡していたが、Havok 移植でラグドールは physics から落ちた
 * (physics/index.js 冒頭コメント)。Babylon の `Physics/v2/ragdoll.js` や
 * PhysicsAggregate + 6DoF 拘束で再構築する選択肢もあったが、
 *   - 22 本の拘束チェーンのチューニング (質量比・コーン角・初期貫通) は
 *     それ自体が数日規模の仕事で、破綻すると「体が通りを飛んでいく」
 *   - Havok の剛体はフィルタを誤ると弾・視線・CC 掃引の全部に干渉する
 * ため、この移植ラウンドでは**決定的で絶対に破綻しない手続きモーション**を
 * 選んだ。被弾方向へ膝から崩れて倒れ、地面に沿って静止する。将来ラグドールを
 * 入れる場合はこのクラスを置き換えるだけでよい (呼び出し面: begin/update/finish)。
 *
 * ## 動き
 *
 *   0.00-0.35  膝が抜ける: 腰が沈み、脚が折れ、上体が前に落ちる
 *   0.15-1.00  倒れ込み: 足元を支点に被弾方向へ 90° 回転 (二次で加速)、
 *              着地間際に 4° のバウンドで戻って静止
 *   全区間     現在の姿勢 → 脱力ポーズへの slerp ブレンド
 *
 * ルートの回転は**アクターのルートノード**に掛ける (ボーンではなく)。倒れる
 * 軸はワールド水平の「被弾方向 × up」で、支点がアクター原点 (足元, y=0) に
 * あるため、90° 回した時点で体は地面の高さに寝る。
 */

import { Vector3, Quaternion, Euler } from './math3.js';

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
    this.t = -1; // 負 = 非アクティブ
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

  get active() {
    return this.t >= 0 && this.t < DURATION;
  }

  get done() {
    return this.t >= DURATION;
  }

  /**
   * @param agent  倒すエージェント (yaw / position / rng を読む)
   * @param dir    被弾の入射方向 (省略時は正面から撃たれた扱い = 後ろへ倒れる)
   * @param groundY 支点の床高さ
   */
  begin(agent, dir, groundY) {
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

  /** キャプチャ演出用: 一気に静止状態まで進める。 */
  finish(out) {
    if (this.t < 0) return;
    this.t = DURATION - 1e-4;
    this.update(1, out);
  }
}

function smooth01(x) {
  return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}
