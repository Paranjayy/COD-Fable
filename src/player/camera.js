import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import { CAMERA, MOVE } from './tuning.js';
import { Spring, RecoilAxis, approach, clamp, clamp01, hashNoise, TAU } from './springs.js';
import { basisFromYaw } from './movement.js';

/**
 * カメラの触感 — 揺れ、反動、傾き、呼吸、FOV。
 *
 * ## なぜ移動と分けるのか
 *
 * Three 版は移動とカメラが同じファイルにあり、「移動の調整をするとカメラの見え方が
 * 変わる」という結合が起きていた。ここでは **movement が決めた状態を読むだけ**にして、
 * 逆向きの依存を作らない。camera は速度も姿勢も書き換えない。
 *
 * ## 加算の順序
 *
 * 目の位置 = キャラクタ位置 + 目の高さ + (bob + 着地の沈み + 傾きのオフセット + 揺れ)
 * 向き     = (yaw, pitch) + 反動 + 呼吸 + 傾きのロール + 揺れ
 *
 * すべて **加算** で、掛け算にしない。掛け算にすると 1 つの成分をゼロにしたときに
 * 他の成分まで消え、調整の因果が追えなくなる。
 */
export class CameraRig {
  constructor(config, rng) {
    this.config = config;
    this.rng = rng;

    /** 水平角。右手系で +Y 軸まわり。 */
    this.yaw = 0;
    /** 上下角。正で上。 */
    this.pitch = 0;

    // --- 反動 ---
    const r = CAMERA.recoil;
    this.recoilPitch = new RecoilAxis(r.freq, r.damping, r.residualTau, r.residualShare);
    this.recoilYaw = new RecoilAxis(r.freq, r.damping, r.residualTau, r.residualShare);
    this.recoilRoll = new RecoilAxis(r.freq * 0.8, r.damping, r.residualTau, r.residualShare);
    /** 銃を構えた腕がカメラを押し戻す成分 (メートル)。 */
    this.punch = new Spring(r.punchFreq, r.punchDamping, 0);

    // --- 着地の沈み込み ---
    this.landDip = new Spring(CAMERA.land.freq, CAMERA.land.damping, 0);
    this.stepDip = new Spring(CAMERA.step.freq, CAMERA.step.damping, 0);

    // --- 状態 ---
    this.bobPhase = 0;
    this.trauma = 0;
    this.leanAmount = 0;
    this.rollAmount = 0;
    this.breathPhase = 0;
    this.suppression = 0;
    this.adsProgress = 0;
    this.fovScale = 1;

    /** 出力。lateUpdate で Babylon のカメラに書き込まれる。 */
    this.eye = new Vector3();
    this.rotation = new Vector3(); // (pitch, yaw, roll)
    this.fov = config.fov;

    this._noiseSeed = 0;
  }

  /**
   * マウス/スティックの視点入力を積む。
   *
   * ADS 中は感度を落とす。これをやらないと、倍率のある光学サイトで狙いが暴れる。
   */
  addLook(dx, dy, adsProgress) {
    const scale = 1 - adsProgress * (1 - this.config.adsSensScale);
    this.yaw -= dx * scale;
    this.pitch -= dy * scale;
    const lim = CAMERA.pitchLimit;
    this.pitch = clamp(this.pitch, -lim, lim);
    // yaw は 2π で畳む。畳まないと長時間プレイで浮動小数の精度が落ちる。
    if (this.yaw > Math.PI) this.yaw -= TAU;
    else if (this.yaw < -Math.PI) this.yaw += TAU;
  }

  /** 武器から呼ばれる反動。角度はラジアン、punch はメートル。 */
  addRecoil(pitch, yaw, roll, punch = 0) {
    this.recoilPitch.kick(pitch);
    this.recoilYaw.kick(yaw);
    this.recoilRoll.kick(roll);
    if (punch) this.punch.impulse(punch);
  }

  /** 画面全体の揺れ。0..1 で累積し、二乗で効かせる (小さい値が目立ちすぎない)。 */
  addTrauma(a) {
    this.trauma = clamp01(this.trauma + a);
  }

  /** 被弾時の抑圧。呼吸の揺れが大きくなる。 */
  addSuppression(a) {
    this.suppression = clamp01(this.suppression + a);
  }

  /**
   * 1 フレーム更新する。
   *
   * @param dt   可変フレーム時間
   * @param move Movement のインスタンス (読み取りのみ)
   * @param opts { ads, leanInput, health, physics }
   */
  update(dt, move, opts) {
    const speed = Math.hypot(move.velocity.x, move.velocity.z);
    const ads = opts.ads ? 1 : 0;
    this.adsProgress = approach(this.adsProgress, ads, CAMERA.fov.adsTau, dt);

    this._updateBob(dt, move, speed);
    this._updateLean(dt, move, opts);
    this._updateRoll(dt, move, opts);
    this._updateSprings(dt);
    this._updateBreath(dt, move, opts);
    this._updateShake(dt);
    this._updateFov(dt, move);
    this._compose(move);
  }

  /* ------------------------------------------------------------------ */

  _updateBob(dt, move, speed) {
    const b = CAMERA.bob;
    /**
     * 歩行の揺れは **移動距離** で位相を進める。時間で進めると、歩く速さを変えた
     * ときに歩調と揺れがずれる (movement の足音と同じ理由)。
     */
    if (move.grounded && !move.sliding) {
      const stride = move.stanceDef.strideLength;
      this.bobPhase += (speed * dt) / Math.max(stride, 0.1) * Math.PI;
      this._bobFade = approach(this._bobFade ?? 0, 1, 0.06, dt);
    } else {
      // 空中では素早く消す。落下中に揺れているとフワフワして見える。
      this._bobFade = approach(this._bobFade ?? 0, 0, b.airFade, dt);
    }
    if (this.bobPhase > TAU * 8) this.bobPhase -= TAU * 8;

    const norm = clamp(speed / MOVE.sprintSpeed, 0, b.speedCap) ** b.speedExp;
    const adsScale = 1 - this.adsProgress * (1 - b.adsScale);
    const amp = norm * (this._bobFade ?? 0) * adsScale;

    // 1:2 のリサージュ。横 1 周期に対して縦 2 周期 = 8 の字。
    this.bobX = Math.sin(this.bobPhase) * b.ampX * amp;
    this.bobY = -Math.abs(Math.cos(this.bobPhase)) * b.ampY * amp;
    this.bobZ = Math.sin(this.bobPhase * 2) * b.ampZ * amp;
    this.bobRoll = Math.sin(this.bobPhase) * b.roll * amp;
    this.bobPitch = Math.cos(this.bobPhase * 2) * b.pitch * amp;
  }

  /** 足が着いた瞬間の微小な沈み。footstep イベントごとに呼ぶ。 */
  onFootstep(running) {
    this.stepDip.impulse(-CAMERA.step.impulse * (running ? CAMERA.step.sprintScale : 1));
  }

  /** 着地。落下速度に応じて沈み込みと揺れを与える。 */
  onLand(speed) {
    const l = CAMERA.land;
    if (speed < l.minSpeed) return 0;
    const t = clamp01((speed - l.minSpeed) / (l.fullSpeed - l.minSpeed));
    this.landDip.impulse(-l.dipImpulse * t);
    this.recoilPitch.kick(-l.pitch * t);
    this.recoilRoll.kick(l.roll * t * (this.rng.float() < 0.5 ? -1 : 1));
    this.addTrauma(l.trauma * t);
    return t;
  }

  _updateLean(dt, move, opts) {
    const want = move.stance === 'stand' && !move.sprinting ? opts.leanInput : 0;
    this.leanAmount = approach(this.leanAmount, want, MOVE.lean.rate, dt);

    /**
     * 傾いた先が壁なら押し戻す。
     *
     * これが無いと、ドア枠から覗こうとしたときにカメラが壁を突き抜けて隣室が見える
     * (いわゆる wall-peek のチート的な挙動になる)。physics に球を投げて詰める。
     */
    if (Math.abs(this.leanAmount) > 0.01 && opts.physics && move.position) {
      const { rx, rz } = basisFromYaw(this.yaw);
      const dir = { x: rx * Math.sign(this.leanAmount), y: 0, z: rz * Math.sign(this.leanAmount) };
      const from = {
        x: move.position.x,
        y: move.position.y + move.eyeHeight - move.height * 0.5,
        z: move.position.z,
      };
      const reach = Math.abs(this.leanAmount) * MOVE.lean.offset + CAMERA.wallPad;
      const hit = opts.physics.sphereCast(from, dir, MOVE.lean.probeRadius, reach);
      if (hit.hit) {
        const allowed = Math.max(0, hit.distance - CAMERA.wallPad) / MOVE.lean.offset;
        this.leanAmount = clamp(this.leanAmount, -allowed, allowed);
      }
    }
  }

  _updateRoll(dt, move, opts) {
    const r = CAMERA.roll;
    // 横移動と旋回でわずかに傾ける。「見える」のではなく「感じる」量に留める。
    const { rx, rz } = basisFromYaw(this.yaw);
    const lateral = move.velocity.x * rx + move.velocity.z * rz;
    let want = -clamp(lateral / MOVE.sprintSpeed, -1, 1) * r.strafe;

    const yawRate = (this.yaw - (this._lastYaw ?? this.yaw)) / Math.max(dt, 1e-4);
    this._lastYaw = this.yaw;
    want += clamp(-yawRate * r.yawRate, -r.yawRateMax, r.yawRateMax);

    if (move.sliding) want += -Math.sign(lateral || 1) * r.slide;
    else if (!move.grounded) want += clamp(lateral, -1, 1) * r.air;

    this.rollAmount = approach(this.rollAmount, want, r.tau, dt);
  }

  _updateSprings(dt) {
    this.recoilPitch.step(dt);
    this.recoilYaw.step(dt);
    this.recoilRoll.step(dt);
    this.punch.step(dt);
    this.landDip.step(dt);
    this.stepDip.step(dt);
  }

  _updateBreath(dt, move, opts) {
    const b = CAMERA.breath;
    this.breathPhase += dt;
    // 2 つの無理数比の正弦を重ねて、周期が読めない揺れにする。単一正弦だと
    // 「機械的に往復している」ことが目で分かってしまう。
    const a = Math.sin(this.breathPhase * TAU * b.freqA);
    const c = Math.sin(this.breathPhase * TAU * b.freqB + 1.7);

    let scale = 1;
    scale *= 1 + this.adsProgress * (b.adsScale - 1);
    if (opts.health !== undefined) {
      const low = clamp01(1 - opts.health / 40);
      scale *= 1 + low * (b.lowHealthScale - 1);
    }
    scale *= 1 + this.suppression * (b.suppressionScale - 1);
    // 動いている間は呼吸の揺れを抑える (体幹が安定している、という表現)。
    const speed = Math.hypot(move.velocity.x, move.velocity.z);
    scale *= 1 - clamp01(speed / MOVE.sprintSpeed) * b.moveDamp;

    this.breathPitch = a * b.amp * scale;
    this.breathYaw = c * b.amp * scale * 0.8;
    this.breathPos = c * b.posAmp * scale;

    this.suppression = approach(this.suppression, 0, 1.2, dt);
  }

  _updateShake(dt) {
    const s = CAMERA.shake;
    this.trauma = Math.max(0, this.trauma - s.decay * dt);
    // trauma の二乗で効かせる。線形だと小さな被弾でも画面が大きく揺れる。
    const t = this.trauma * this.trauma;
    if (t <= 0) {
      this.shakePitch = this.shakeYaw = this.shakeRoll = 0;
      this.shakeX = this.shakeY = 0;
      return;
    }
    /**
     * 揺れのノイズは `hashNoise` (決定的) を使う。Math.random() を使うと
     * ARCHITECTURE.md Hard rule 4 に違反し、キャプチャが揺れる。
     */
    this._noiseSeed += dt * s.freq;
    // hashNoise は既に -1..1 を返す。ここで *2-1 すると -3..1 に偏り、揺れが
    // 一方向に寄る (実際に一度やらかした)。
    const n = (k) => hashNoise(this._noiseSeed, k);
    const deg = (Math.PI / 180) * s.rot * t;
    this.shakePitch = n(1) * deg;
    this.shakeYaw = n(2) * deg;
    this.shakeRoll = n(3) * deg * 0.7;
    this.shakeX = n(4) * s.pos * t;
    this.shakeY = n(5) * s.pos * t;
  }

  _updateFov(dt, move) {
    const f = CAMERA.fov;
    let want = 1;
    if (move.tacSprinting) want = f.tacSprint;
    else if (move.sprinting) want = f.sprint;
    else if (move.sliding) want = f.slide;
    else if (!move.grounded) want = f.air;

    this.fovScale = approach(this.fovScale, want, f.moveTau, dt);
    // ADS は別時定数。移動 FOV より速く効かないと構えが鈍く感じる。
    const adsFov = 1 - this.adsProgress * (1 - this.config.adsFovScale);
    this.fov = this.config.fov * this.fovScale * adsFov;
  }

  /** 全成分を合成して eye / rotation に書き出す。 */
  _compose(move) {
    const { fx, fz, rx, rz } = basisFromYaw(this.yaw);

    // 傾きの横移動。
    const leanOff = this.leanAmount * MOVE.lean.offset;
    const leanDrop = Math.abs(this.leanAmount) * MOVE.lean.drop;

    // 反動の押し戻しは視線方向の逆に働く。
    const punch = this.punch.value;

    const p = move.position ?? { x: 0, y: 0, z: 0 };
    // physics のカプセルは中心が原点。目は中心から (eyeHeight - height/2) 上。
    const eyeY = p.y + (move.eyeHeight - move.height * 0.5);

    this.eye.set(
      p.x + rx * (leanOff + this.bobX + this.shakeX) + fx * (this.bobZ - punch),
      eyeY + this.bobY + this.landDip.value + this.stepDip.value - leanDrop + this.shakeY + this.breathPos,
      p.z + rz * (leanOff + this.bobX + this.shakeX) + fz * (this.bobZ - punch)
    );

    this.rotation.set(
      -(this.pitch + this.recoilPitch.value + this.bobPitch + this.breathPitch + this.shakePitch),
      this.yaw + this.recoilYaw.value + this.breathYaw + this.shakeYaw,
      this.rollAmount +
        this.recoilRoll.value +
        this.bobRoll +
        this.shakeRoll +
        this.leanAmount * MOVE.lean.roll
    );
  }

  /**
   * Babylon のカメラへ書き込む。
   *
   * **Babylon の FreeCamera.rotation は (pitch, yaw, roll) で、pitch は下向きが正**。
   * こちらの内部表現は上向きが正なので、_compose で符号を反転させてある。ここで
   * 二重に反転させないこと (上下が逆になり、しかも「なんとなく操作できてしまう」)。
   */
  applyTo(camera) {
    camera.position.copyFrom(this.eye);
    camera.rotation.copyFrom(this.rotation);
    camera.fov = (this.fov * Math.PI) / 180;
  }
}
