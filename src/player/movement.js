import { STANCE, MOVE, JUMP_SPEED } from './tuning.js';
import { clamp, clamp01, approach } from './springs.js';

/**
 * 移動ステートマシン。
 *
 * ## 責務の境界
 *
 * ここは **速度と姿勢だけ**を決める。カメラの揺れも銃の構えも知らない
 * (camera.js と weapons が `player:state` イベントを見て自分で反応する)。
 * 分けている理由は、Three 版で「移動を直すたびにカメラの見え方が変わる」という
 * 結合が起きていたため。
 *
 * ## 座標系
 *
 * 水平方向は yaw から作る右手系。`forward` は -Z を向くカメラ前方、`right` は +X。
 * physics のキャラクタには **速度** を渡す (変位ではない)。
 *
 * ## fixedUpdate で回すこと
 *
 * 加速度・摩擦・スライドの減衰はすべて固定ステップ前提の係数で調整してある。
 * 可変 dt で回すとフレームレートによって挙動が変わり、しかも「なんとなく動く」ので
 * 発見が遅れる。
 */
export class Movement {
  constructor(physics, rng) {
    this.physics = physics;
    this.rng = rng;

    /** 'stand' | 'crouch' | 'prone' */
    this.stance = 'stand';
    /** 遷移中の実効カプセル高さ。stance の目標値に向かって補間される。 */
    this.height = STANCE.stand.height;
    this.eyeHeight = STANCE.stand.eye;

    this.velocity = { x: 0, y: 0, z: 0 };
    this.grounded = false;
    this.groundNormal = { x: 0, y: 1, z: 0 };
    this.groundSurface = 'concrete';

    this.sprinting = false;
    this.tacSprinting = false;
    this.sliding = false;
    this.ads = false;

    /** 直近の着地速度 (m/s, 正値)。着地 FX と落下ダメージ用。1 フレームだけ立つ。 */
    this.landingSpeed = 0;
    /** 歩数の累積距離。footstep イベントの発火に使う。 */
    this._strideAccum = 0;
    /** 左右どちらの足か。足音の左右振り分けに使う。 */
    this._stepParity = 0;

    this._coyote = 0;
    this._jumpBuffer = 0;
    this._jumpCooldown = 0;
    this._slideTime = 0;
    this._slideCooldown = 0;
    this._sprintTapTime = -1;
    this._tacSprintTime = 0;
    this._sprintHeld = 0;

    this._wantJump = false;
    this._enabled = true;
  }

  attach(character) {
    this.character = character;
    return this;
  }

  setEnabled(on) {
    this._enabled = on;
    if (!on) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.sprinting = false;
      this.tacSprinting = false;
      this.sliding = false;
    }
  }

  /** 現在の姿勢定義。 */
  get stanceDef() {
    return STANCE[this.stance];
  }

  /**
   * 1 物理ステップ進める。
   *
   * @param h   固定ステップ (秒)
   * @param cmd { moveX, moveY, yaw, jump, crouchHeld, proneToggle, sprintHeld, ads }
   *            moveX/moveY は正規化済みの入力 (右 +X / 前 +Y)
   */
  step(h, cmd) {
    const c = this.character;
    if (!c) return;

    if (!this._enabled) {
      // 制御が切れているときも重力だけは効かせる。切った瞬間に空中で固まると、
      // ショット適用後にカメラだけ動いて足元が置き去りになる。
      c.move(0, 0, 0);
      this._syncFromCharacter(c);
      return;
    }

    this._jumpCooldown = Math.max(0, this._jumpCooldown - h);
    this._slideCooldown = Math.max(0, this._slideCooldown - h);

    this._updateStance(h, cmd);
    this._updateSprint(h, cmd);
    this._updateSlide(h, cmd);

    const speed = this._targetSpeed(cmd);
    const { fx, fz, rx, rz } = basisFromYaw(cmd.yaw);

    // 希望する水平速度。
    let wx = (rx * cmd.moveX + fx * cmd.moveY) * speed;
    let wz = (rz * cmd.moveX + fz * cmd.moveY) * speed;

    if (this.sliding) {
      // スライド中は入力で「曲げる」だけ。加速はできない。
      const steer = MOVE.slide.steer * h;
      this.velocity.x += rx * cmd.moveX * steer;
      this.velocity.z += rz * cmd.moveX * steer;
      this._applySlideDrag(h);
    } else if (this.grounded) {
      const moving = Math.hypot(cmd.moveX, cmd.moveY) > 0.01;
      const accel = moving ? MOVE.groundAccel : MOVE.stopDecel;
      this.velocity.x = moveTowardScalar(this.velocity.x, wx, accel * h);
      this.velocity.z = moveTowardScalar(this.velocity.z, wz, accel * h);
    } else {
      /**
       * 空中制御。地上の 1/4 の権限しか無く、**速度を増やすことはできない**。
       * これが無いと空中で加速し続けられてしまい、ジャンプが移動手段になる。
       */
      const cur = Math.hypot(this.velocity.x, this.velocity.z);
      const want = Math.hypot(wx, wz);
      const a = MOVE.groundAccel * MOVE.airAccelScale * h;
      const nx = moveTowardScalar(this.velocity.x, wx, a);
      const nz = moveTowardScalar(this.velocity.z, wz, a);
      const after = Math.hypot(nx, nz);
      // 速度が増える方向なら上限を課す。
      if (after <= Math.max(cur, MOVE.airSpeedCap) || want < cur) {
        this.velocity.x = nx;
        this.velocity.z = nz;
      }
    }

    this._updateJump(h, cmd);

    // physics には「速度」を渡す。重力とスロープ処理は Havok 側が行う。
    c.move(this.velocity.x, this.velocity.y, this.velocity.z);
    this._syncFromCharacter(c);
    this._accumulateStride(h);
  }

  _syncFromCharacter(c) {
    this.velocity.x = c.velocity.x;
    this.velocity.y = c.velocity.y;
    this.velocity.z = c.velocity.z;
    this.grounded = c.grounded;
    this.groundNormal = c.groundNormal;
    this.groundSurface = c.groundSurfaceName;
    this.landingSpeed = c.landingSpeed;
    this.position = c.position;

    if (this.grounded) this._coyote = MOVE.coyoteTime;
    else this._coyote = Math.max(0, this._coyote - this.physics.fixedDt);

    // 着地したらスライド以外の空中状態を解除。
    if (this.landingSpeed > 0) this._tacSprintTime = Math.min(this._tacSprintTime, MOVE.tacSprintMaxTime);
  }

  /* ------------------------------------------------------------------ */
  /* Stance                                                              */
  /* ------------------------------------------------------------------ */

  _updateStance(h, cmd) {
    const c = this.character;
    let want = 'stand';
    if (cmd.proneHeld) want = 'prone';
    else if (cmd.crouchHeld || this.sliding) want = 'crouch';

    /**
     * 立ち上がれるかを必ず確認する。天井の下でしゃがみ解除を許すと、カプセルが
     * ジオメトリにめり込んで Havok が押し出し、プレイヤーが弾き飛ばされる。
     */
    if (want === 'stand' && this.stance !== 'stand' && !c.canFit(STANCE.stand.height)) {
      want = this.stance === 'prone' ? 'crouch' : this.stance;
    }
    this.stance = want;

    const def = STANCE[want];
    const tau =
      want === 'prone' || this.stance === 'prone'
        ? MOVE.stanceTau.prone
        : want === 'crouch'
          ? MOVE.stanceTau.standCrouch
          : MOVE.stanceTau.crouchStand;

    this.height = approach(this.height, def.height, tau, h);
    this.eyeHeight = approach(this.eyeHeight, def.eye, tau, h);
    c.setHeight(this.height);
  }

  /* ------------------------------------------------------------------ */
  /* Sprint                                                              */
  /* ------------------------------------------------------------------ */

  _updateSprint(h, cmd) {
    const forwardish = cmd.moveY > MOVE.sprintForwardDot;
    const wantSprint = cmd.sprintHeld && forwardish && !cmd.ads && this.stance === 'stand';

    /**
     * タクティカルスプリントはスプリントキーのダブルタップ (MWII 方式)。
     * 押した瞬間だけを見て、前回の押下からの間隔が窓内なら昇格する。
     */
    if (cmd.sprintPressed) {
      if (this._sprintTapTime >= 0 && this._sprintTapTime < MOVE.tacSprintTapWindow) {
        this.tacSprinting = true;
        this._tacSprintTime = 0;
      }
      this._sprintTapTime = 0;
    } else if (this._sprintTapTime >= 0) {
      this._sprintTapTime += h;
      if (this._sprintTapTime > MOVE.tacSprintTapWindow) this._sprintTapTime = -1;
    }

    if (!wantSprint) {
      this.sprinting = false;
      this.tacSprinting = false;
      this._sprintHeld = 0;
      return;
    }

    // 押してすぐには乗らない。わずかな遅延が「駆け出す」感触を作る。
    this._sprintHeld += h;
    this.sprinting = this._sprintHeld >= MOVE.sprintStartDelay;

    if (this.tacSprinting) {
      this._tacSprintTime += h;
      if (this._tacSprintTime > MOVE.tacSprintMaxTime) this.tacSprinting = false;
    }
  }

  _targetSpeed(cmd) {
    const def = this.stanceDef;
    let s = def.speed;
    if (this.sprinting) s = this.tacSprinting ? MOVE.tacSprintSpeed : MOVE.sprintSpeed;
    if (cmd.ads) s *= MOVE.adsScale;

    // 方向による減速。横は 0.92、後退は 0.8。
    const dirScale =
      cmd.moveY < -0.01 ? MOVE.backScale : Math.abs(cmd.moveX) > Math.abs(cmd.moveY) ? MOVE.strafeScale : 1;
    return s * dirScale;
  }

  /* ------------------------------------------------------------------ */
  /* Slide                                                               */
  /* ------------------------------------------------------------------ */

  _updateSlide(h, cmd) {
    if (this.sliding) {
      this._slideTime += h;
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      if (
        this._slideTime > MOVE.slide.duration ||
        speed < MOVE.slide.exitSpeed ||
        !this.grounded ||
        !cmd.crouchHeld
      ) {
        this.sliding = false;
        this._slideCooldown = MOVE.slide.cooldown;
      }
      return;
    }

    // スライド開始条件: スプリント中にしゃがみを押し、十分な速度が出ていること。
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (
      cmd.crouchPressed &&
      this.sprinting &&
      this.grounded &&
      this._slideCooldown <= 0 &&
      speed >= MOVE.slide.minSpeedToStart
    ) {
      this.sliding = true;
      this._slideTime = 0;
      // 開始時に必ず「押し出される」感触を出す。遅くても minEntry まで持ち上げる。
      const entry = Math.max(MOVE.slide.minEntry, Math.min(MOVE.slide.entrySpeed, speed * 1.22));
      const k = entry / Math.max(speed, 1e-3);
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
  }

  _applySlideDrag(h) {
    const s = MOVE.slide;
    // 指数減衰 + 線形ブレーキ。2 つを併用するのは、指数だけだと止まり際が
    // 間延びし、線形だけだと高速域の減速が足りないため。
    const decay = Math.exp(-s.drag * h);
    this.velocity.x *= decay;
    this.velocity.z *= decay;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed > 1e-4) {
      const brake = Math.min(speed, s.brake * h);
      this.velocity.x -= (this.velocity.x / speed) * brake;
      this.velocity.z -= (this.velocity.z / speed) * brake;
    }
    // 下り坂ではスライドが生き延びる。
    const n = this.groundNormal;
    if (n.y > 0.2 && n.y < 0.999) {
      this.velocity.x += n.x * s.slopeAssist * h;
      this.velocity.z += n.z * s.slopeAssist * h;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Jump                                                                */
  /* ------------------------------------------------------------------ */

  _updateJump(h, cmd) {
    if (cmd.jumpPressed) this._jumpBuffer = MOVE.jumpBuffer;
    else this._jumpBuffer = Math.max(0, this._jumpBuffer - h);

    /**
     * コヨーテタイム + 入力バッファ。
     *
     * 「崖から落ちた直後でも跳べる」「着地の直前に押しても跳べる」の 2 つは、
     * どちらもプレイヤーの入力誤差を吸収するためのもの。片方だけだと、着地際の
     * ジャンプが不発になる場面が残る。
     */
    const canJump = (this.grounded || this._coyote > 0) && this._jumpCooldown <= 0;
    if (this._jumpBuffer > 0 && canJump && this.stance === 'stand') {
      this.velocity.y = JUMP_SPEED;
      this.character.ctrl.setVelocity(
        setYOn(this.character.ctrl.getVelocity(), JUMP_SPEED)
      );
      this._jumpBuffer = 0;
      this._coyote = 0;
      this._jumpCooldown = MOVE.jumpCooldown;
      this.sliding = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Footsteps                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 歩幅を累積して足音のタイミングを決める。
   *
   * 時間ではなく **移動距離** で刻むのが要点。時間で刻むと、遅く歩いても速く走っても
   * 同じ間隔で鳴ってしまい、歩調と足音がずれる。
   */
  _accumulateStride(h) {
    this.footstep = null;
    if (!this.grounded || this.sliding) return;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed < 0.4) return;

    this._strideAccum += speed * h;
    const stride = this.stanceDef.strideLength * (this.sprinting ? 1.18 : 1);
    if (this._strideAccum >= stride) {
      this._strideAccum -= stride;
      this._stepParity ^= 1;
      this.footstep = {
        surface: this.groundSurface,
        running: this.sprinting,
        parity: this._stepParity,
        speed,
      };
    }
  }
}

/** yaw から水平の前方/右方ベクトルを作る。右手系、前方は -Z。 */
export function basisFromYaw(yaw) {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return {
    fx: -s,
    fz: -c,
    rx: c,
    rz: -s,
  };
}

function moveTowardScalar(cur, target, maxDelta) {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

/** Babylon の Vector3 の y だけ差し替えた新しい値を返す (元を壊さない)。 */
function setYOn(v, y) {
  v.y = y;
  return v;
}

export { clamp, clamp01 };
