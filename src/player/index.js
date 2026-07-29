import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import { Movement, basisFromYaw } from './movement.js';
import { CameraRig } from './camera.js';
import { HEALTH, CAMERA, FOOTSTEP, STANCE } from './tuning.js';
import { clamp01, approach } from './springs.js';

/**
 * PLAYER — 移動ステートマシン、カメラの触感、体力。
 *
 * ## 構成
 *
 *   movement.js  速度と姿勢だけを決める。カメラを知らない
 *   camera.js    movement の状態を読んでカメラの見え方を作る。移動を書き換えない
 *   index.js     この 2 つを繋ぎ、体力とイベントを持つ
 *
 * 一方向の依存 (camera → movement) にしてあるのは、Three 版で「移動の調整をすると
 * カメラの見え方が変わる」という双方向の結合が起きていたため。
 *
 * ## 発行するイベント (ARCHITECTURE.md の語彙)
 *
 *   player:state    { stance, sprinting, sliding, ads }
 *   player:footstep { position, surface, running }
 *   player:land     { velocity, surface }
 *   damage:taken    { amount, from, health }
 *
 * ## 購読するイベント
 *
 *   damage:dealt    自分が対象のものだけ拾う (target が player のとき)
 *   explosion       近ければダメージと抑圧
 *   bullet:impact   近傍を掠めた弾で抑圧
 */
export class PlayerSystem {
  static id = 'player';
  static deps = ['physics', 'world', 'render'];

  constructor() {
    this.health = HEALTH.max;
    this.alive = true;
    this._regenTimer = 0;
    this._hitFlash = 0;
    /** 被弾方向インジケータ。UI が読む。 */
    this.indicators = [];
    this._controlEnabled = true;
    this._landHold = 0;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.physics = ctx.get('physics');
    this.world = ctx.get('world');
    this.render = ctx.get('render');

    const spawn = this.world.spawn(0);
    this.character = this.physics.createCharacter({
      position: spawn.position,
      height: STANCE.stand.height,
      radius: 0.32,
      stepHeight: STANCE.stand.stepHeight,
      slopeLimit: 52,
    });
    this._snapToGround(spawn.position);

    this.movement = new Movement(this.physics, this.rng).attach(this.character);
    this.camera = new CameraRig(ctx.config, this.rng);
    this.camera.yaw = spawn.yaw ?? 0;

    this._wireEvents(ctx);
  }

  /**
   * スポーン位置を地面に載せる。
   *
   * `world.spawn()` の座標は「だいたいこのあたり」を示すもので、地形の高さまでは
   * 持っていない。そのまま使うとカプセルが空中から落ちるところから始まり:
   *
   *   - 落下中は接地していないので **空中制御の弱い加速しか効かない**
   *   - 実測で、W を 45 フレーム押しても 0.94 m しか進まなかった (期待は約 3.4 m)。
   *     半分以上のフレームを落下に使っていた
   *   - キャプチャのショットでも、最初の数フレームだけ絵が動いてしまう
   *
   * 真下にレイを落として、足がその高さに来るようカプセル中心を置き直す。
   * 地面が見つからない場合は spawn の値をそのまま使う (奈落に落ちるのを避ける)。
   */
  _snapToGround(position) {
    /**
     * **キャストの開始点を高くしすぎないこと。**
     *
     * 最初 `position.y + 6` から落としたところ、市場の屋台の日除け (高さ 2.05 m) や
     * 建物の庇を拾ってしまい、スポーンが 1.8 m → 4.04 m に **上がった**。
     * 「地面を探す」つもりが「頭上の一番近い天井」を探していた。
     *
     * spawn はプレイヤーの立ち位置を指しているので、そこから少し上
     * (カプセル中心 + 0.5 m) を開始点にすれば、頭上の構造物より下から探し始められる。
     */
    const y = this.physics.groundHeight(position.x, position.z, position.y + 0.5);
    if (!Number.isFinite(y)) return;
    // 足がその高さに来るようカプセル中心を置く。わずかに浮かせてめり込みを防ぐ。
    this.character.teleport(position.x, y + STANCE.stand.height * 0.5 + 0.02, position.z);
  }

  _wireEvents(ctx) {
    ctx.events.on('damage:dealt', (e) => this._onDamageDealt(e));
    ctx.events.on('explosion', (e) => this._onExplosion(e));
    ctx.events.on('bullet:impact', (e) => this._onBulletImpact(e));
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  /**
   * 移動は固定ステップで回す。
   *
   * 加速度・摩擦・スライドの減衰はすべて固定ステップ前提の係数で調整してある。
   * 可変 dt で回すとフレームレートで挙動が変わり、しかも「なんとなく動く」ので
   * 発見が遅れる。
   */
  fixedUpdate(h, ctx) {
    const input = ctx.input;
    const mv = { x: 0, y: 0 };
    if (this._controlEnabled) input.moveVector(mv);

    this.movement.step(h, {
      moveX: mv.x,
      moveY: mv.y,
      yaw: this.camera.yaw,
      jumpPressed: this._controlEnabled && input.actionPressed('jump'),
      crouchHeld: this._controlEnabled && input.action('crouch'),
      crouchPressed: this._controlEnabled && input.actionPressed('crouch'),
      proneHeld: this._controlEnabled && input.action('prone'),
      sprintHeld: this._controlEnabled && input.action('sprint'),
      sprintPressed: this._controlEnabled && input.actionPressed('sprint'),
      ads: this._controlEnabled && input.ads,
    });

    this._drainMovementEvents(ctx);
  }

  update(dt, ctx) {
    const input = ctx.input;

    if (this._controlEnabled) {
      // 視点入力。ゲームパッドのスティックも同じ経路に流す。
      const stickScale = dt * 3.2;
      this.camera.addLook(
        input.look.x + input.stick.lookX * stickScale,
        input.look.y + input.stick.lookY * stickScale,
        this.camera.adsProgress
      );
    }

    const lean =
      (this._controlEnabled && input.action('leanRight') ? 1 : 0) -
      (this._controlEnabled && input.action('leanLeft') ? 1 : 0);

    this.camera.update(dt, this.movement, {
      ads: this._controlEnabled && input.ads,
      leanInput: lean,
      health: this.health,
      physics: this.physics,
    });

    this._updateHealth(dt);
    this._publishState(ctx);
  }

  /**
   * カメラの適用は lateUpdate で行う。
   *
   * update の中で書くと、他サブシステム (weapons のビューモデル、ai の画面内判定) が
   * 「今フレームのカメラ」と「前フレームのカメラ」のどちらを見ているかが呼び出し順に
   * 依存してしまう。lateUpdate に寄せれば、全員が確定後の値を見る。
   */
  lateUpdate(dt, ctx) {
    this.camera.applyTo(ctx.camera);
  }

  /* ================================================================== */
  /* Movement-driven events                                             */
  /* ================================================================== */

  _drainMovementEvents(ctx) {
    const m = this.movement;

    // 着地。
    if (m.landingSpeed > 0) {
      const t = this.camera.onLand(m.landingSpeed);
      this._landHold = FOOTSTEP.landHold;
      ctx.events.emit('player:land', {
        velocity: m.landingSpeed,
        surface: m.groundSurface,
        position: this._eyePosition(),
      });
      // 高所からの落下はダメージ。CoD は概ね 15 m/s から。
      const l = CAMERA.land;
      if (m.landingSpeed > l.damageSpeed) {
        this.applyDamage((m.landingSpeed - l.damageSpeed) * l.damagePerSpeed, null, {
          kind: 'fall',
        });
      }
      void t;
    }

    // 足音。着地直後は抑制する (二重のトランジェントになるため)。
    this._landHold = Math.max(0, this._landHold - this.physics.fixedDt);
    if (m.footstep && this._landHold <= 0) {
      this.camera.onFootstep(m.footstep.running);
      const p = m.position;
      // 足は体の中心から左右にずれている。FX と音のパンに使う。
      const { rx, rz } = basisFromYaw(this.camera.yaw);
      const side = m.footstep.parity ? 1 : -1;
      ctx.events.emit('player:footstep', {
        position: new Vector3(
          p.x + rx * FOOTSTEP.lateral * side,
          p.y - m.height * 0.5,
          p.z + rz * FOOTSTEP.lateral * side
        ),
        surface: m.footstep.surface,
        running: m.footstep.speed > FOOTSTEP.runSpeed,
      });
    }
  }

  _publishState(ctx) {
    const m = this.movement;
    const state = {
      stance: m.stance,
      sprinting: m.sprinting,
      tacSprinting: m.tacSprinting,
      sliding: m.sliding,
      ads: this.camera.adsProgress > 0.5,
      adsProgress: this.camera.adsProgress,
      speed: Math.hypot(m.velocity.x, m.velocity.z),
      grounded: m.grounded,
    };
    // 変化したときだけ流す。毎フレーム流すと購読側 (audio) が状態遷移を
    // 検出できなくなる。
    const key = `${state.stance}|${state.sprinting}|${state.sliding}|${state.ads}`;
    if (key !== this._lastStateKey) {
      this._lastStateKey = key;
      ctx.events.emit('player:state', state);
    }
    this.state = state;
  }

  /* ================================================================== */
  /* Health                                                             */
  /* ================================================================== */

  _updateHealth(dt) {
    this._hitFlash = approach(this._hitFlash, 0, HEALTH.effect.hitFlashTau, dt);

    if (!this.alive) return;
    this._regenTimer += dt;
    if (this._regenTimer > HEALTH.regenDelay && this.health < HEALTH.max) {
      // 回復は立ち上がりを緩やかにする。被弾直後に一気に戻ると緊張感が消える。
      const ramp = clamp01((this._regenTimer - HEALTH.regenDelay) / HEALTH.regenRamp);
      this.health = Math.min(HEALTH.max, this.health + HEALTH.regenRate * ramp * dt);
    }

    // 被弾方向インジケータの寿命。
    for (let i = this.indicators.length - 1; i >= 0; i--) {
      this.indicators[i].age += dt;
      if (this.indicators[i].age > HEALTH.indicatorTime) this.indicators.splice(i, 1);
    }
  }

  applyDamage(amount, from, opts = {}) {
    if (!this.alive || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this._regenTimer = 0;
    this._hitFlash = HEALTH.effect.hitFlash;
    this.camera.addTrauma(Math.min(0.5, amount / 60));
    this.camera.addSuppression(HEALTH.suppression.perHit);

    if (from) {
      // 画面のどちらから来たかを yaw に対する相対角で持つ。UI がこれを回す。
      const dx = from.x - this.movement.position.x;
      const dz = from.z - this.movement.position.z;
      const angle = Math.atan2(dx, -dz) - this.camera.yaw;
      this.indicators.push({ angle, age: 0, amount });
      if (this.indicators.length > HEALTH.indicatorMax) this.indicators.shift();
    }

    this.ctx.events.emit('damage:taken', {
      amount,
      from: from ?? null,
      health: this.health,
      kind: opts.kind ?? 'bullet',
    });

    if (this.health <= 0) this._die();
  }

  heal(a) {
    this.health = Math.min(HEALTH.max, this.health + a);
  }

  addSuppression(a) {
    this.camera.addSuppression(a);
  }

  _die() {
    this.alive = false;
    this.movement.setEnabled(false);
    this.ctx.events.emit('actor:death', {
      actor: this,
      point: this._eyePosition(),
      impulse: new Vector3(),
    });
  }

  respawn(index = 0) {
    const s = this.world.spawn(index);
    this.health = HEALTH.max;
    this.alive = true;
    this._regenTimer = HEALTH.regenDelay;
    this.indicators.length = 0;
    this.character.teleport(s.position.x, s.position.y, s.position.z);
    this.camera.yaw = s.yaw ?? 0;
    this.camera.pitch = 0;
    this.movement.setEnabled(this._controlEnabled);
  }

  /* ================================================================== */
  /* Event handlers                                                     */
  /* ================================================================== */

  /**
   * `damage:dealt` は「target にダメージを与えた」という意味 (ARCHITECTURE.md)。
   * 自分宛てのものだけを拾い、**ダメージの適用は対象自身が行う** — 発行側でも
   * 適用すると二重に減る。
   */
  _onDamageDealt(e) {
    if (!this._isMe(e.target)) return;
    this.applyDamage(e.amount, e.point, { kind: e.headshot ? 'headshot' : 'bullet' });
  }

  _isMe(t) {
    return t === this || t === 'player' || t?.isPlayer === true;
  }

  _onExplosion(e) {
    const p = e.position ?? e;
    const me = this.movement.position;
    if (!me) return;
    const d = Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z);
    const radius = e.radius ?? 5;
    if (d > radius) return;
    // 遮蔽されていればダメージなし。壁の裏の爆発で死ぬのは理不尽。
    if (!this.physics.lineOfSight(p, this._eyePosition(), this.physics.MASK.EXPLOSION)) return;
    const falloff = 1 - d / radius;
    this.applyDamage((e.damage ?? 90) * falloff * falloff, p, { kind: 'explosion' });
    this.camera.addSuppression(HEALTH.suppression.perExplosion);
    this.camera.addTrauma(0.7 * falloff);
  }

  /** 近くを掠めた弾で抑圧を受ける。当たっていなくても手元が揺れる。 */
  _onBulletImpact(e) {
    if (e.actor && this._isMe(e.actor)) return; // 直撃は damage:dealt 側で処理済み
    const me = this.movement.position;
    if (!me) return;
    const d = Math.hypot(e.point.x - me.x, e.point.y - me.y, e.point.z - me.z);
    if (d < HEALTH.suppression.radius) {
      this.camera.addSuppression(HEALTH.suppression.perNearMiss * (1 - d / HEALTH.suppression.radius));
    }
  }

  /* ================================================================== */
  /* Public API                                                         */
  /* ================================================================== */

  /** weapons から呼ばれる反動。 */
  addRecoil(pitch, yaw, roll, punch) {
    this.camera.addRecoil(pitch, yaw, roll, punch);
  }

  addKick(pitch, yaw, roll) {
    this.camera.addRecoil(pitch, yaw, roll, 0);
  }

  addTrauma(a) {
    this.camera.addTrauma(a);
  }

  addCameraShake(a) {
    this.camera.addTrauma(a);
  }

  /** UI が読む状態のまとめ。 */
  getHudState() {
    const m = this.movement;
    return {
      health: this.health,
      maxHealth: HEALTH.max,
      alive: this.alive,
      lowHealth: this.health / HEALTH.max < HEALTH.lowThreshold,
      critical: this.health / HEALTH.max < HEALTH.criticalThreshold,
      hitFlash: this._hitFlash,
      indicators: this.indicators,
      stance: m.stance,
      sprinting: m.sprinting,
      sliding: m.sliding,
      ads: this.camera.adsProgress,
      speed: Math.hypot(m.velocity.x, m.velocity.z),
      position: m.position,
      yaw: this.camera.yaw,
    };
  }

  /** 目の位置 (world)。fx / audio / ai が使う。 */
  _eyePosition() {
    return this.camera.eye;
  }

  position() {
    return this.movement.position;
  }

  /**
   * 制御の ON/OFF。キャプチャのショット適用時に切られる。
   *
   * 切っても重力は効かせる (movement.step 参照)。空中で固まると、カメラだけ動いて
   * 足元が置き去りになる。
   */
  setControlEnabled(on) {
    this._controlEnabled = on;
    this.movement.setEnabled(on);
  }

  /**
   * カメラ位置へプレイヤーを移動させる。ショット適用時に、ゲームプレイ側の整合を
   * 保つために呼ばれる。
   */
  teleport(eyeOrPos, rot) {
    const p = eyeOrPos;
    const m = this.movement;
    // 与えられるのは「目の位置」なので、カプセル中心に直す。
    const centreY = p.y - (m.eyeHeight - m.height * 0.5);
    this.character.teleport(p.x, centreY, p.z);
    if (rot) {
      // Babylon の camera.rotation は (pitch, yaw, roll)、pitch は下向きが正。
      this.camera.pitch = -rot.x;
      this.camera.yaw = rot.y;
    }
  }

  setAdsProgress(v) {
    this.camera.adsProgress = clamp01(v);
  }

  /** キャプチャ用のデバッグ状態。 */
  debugState(name) {
    if (name === 'hurt') {
      this.health = 28;
      this._hitFlash = 0.6;
      this.indicators = [{ angle: 1.1, age: 0, amount: 30 }];
    } else if (name === 'clean') {
      this.health = HEALTH.max;
      this._hitFlash = 0;
      this.indicators.length = 0;
    }
  }

  dispose() {
    this.physics.removeCharacter(this.character);
  }
}
