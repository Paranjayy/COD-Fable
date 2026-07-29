import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

import { Rng } from '../core/rng.js';
import { WeaponMaterials } from './materials.js';
import { Viewmodel } from './viewmodel.js';
import { ProjectileSim } from './ballistics.js';
import { WEAPON_DEFS, buildRecoilPattern, SPREAD_MODS } from './defs.js';
import { buildRifle } from './models/rifle.js';
import { buildSmg } from './models/smg.js';
import { buildPistol } from './models/pistol.js';
import { lerp, DEG } from './mathx.js';

/**
 * WEAPONS — weapon meshes, the first-person viewmodel rig, ADS, recoil, sway,
 * bob, reload/inspect animation and projectile ballistics (Babylon 移植版)。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES HERE
 *   geometry.js   hard-surface kit (Babylon 移植の中心 — Three 互換 API の Geo)
 *   parts.js      real firearm components (寸法データ・実質無改変)
 *   models/*.js   the three weapons (無改変)
 *   hands.js      gloved hands + sleeved arms, two-bone IK
 *   viewmodel.js  the animation stack (1 カメラ + renderingGroupId 構成)
 *   clips.js      keyframed reload / inspect / draw timelines (無改変)
 *   ballistics.js travelling projectiles with gravity and drag
 *   defs.js       every tuning number + deterministic recoil patterns (無改変)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const wp = ctx.get('weapons')` (Three 版から不変)
 *   wp.current / wp.ammo / wp.fireMode / wp.spreadDegrees / wp.adsProgress
 *   wp.reloading / wp.firing / wp.switching / wp.inspecting / wp.weaponIds
 *   wp.setWeapon(id) / wp.nextWeapon() / wp.cycleFireMode()
 *   wp.reload() / wp.inspect() / wp.canFire() / wp.tryFire()
 *   wp.muzzleWorld(v3) / wp.getHudState() / wp.debugPose(kind, opts)
 *   wp.setWeaponImmediate(id) / wp.viewmodel / wp.stats
 *
 * EVENTS EMITTED  (all canonical, see ARCHITECTURE.md — ペイロード不変)
 *   weapon:fire    { weapon, origin, dir, seed }
 *   weapon:shell   { position, velocity }
 *   weapon:reload  { weapon, phase: 'start'|'magout'|'magin'|'end' }
 *   bullet:tracer  { from, to, speed }
 * `bullet:impact` comes from physics, because physics owns penetration.
 */
export class WeaponSystem {
  static id = 'weapons';
  static deps = ['materials', 'physics'];

  constructor() {
    this.viewmodel = null;
    this.sim = null;
    this.states = new Map();
    this.activeId = 'rifle';
    this.debugMode = null;

    this._fireTimer = 0;
    this._burstLeft = 0;
    this._burstCooldown = 0;
    this._spread = 0;
    this._shotIndex = 0;
    this._sinceShot = 10;
    this._switchTimer = 0;
    this._switchTo = null;

    this._muzzle = new Vector3();
    this._dir = new Vector3();
    this._right = new Vector3();
    this._up = new Vector3();
    this._tmp = new Vector3();
    this._camDir = new Vector3();
    // カメラのローカル軸 (RH ビュー行列なので前方は -Z)。
    this._LOCAL_FWD = new Vector3(0, 0, -1);
    this._LOCAL_RIGHT = new Vector3(1, 0, 0);
    this._LOCAL_UP = new Vector3(0, 1, 0);
    this._firePayload = { weapon: null, origin: new Vector3(), dir: new Vector3(), seed: 0 };
    this._reloadPayload = { weapon: null, phase: 'start' };
    // `weapon:shell` carries the canonical { position, velocity } plus the real
    // case dimensions and a spin, so fx can size and tumble the brass.
    this._shellPayload = {
      position: new Vector3(),
      velocity: new Vector3(),
      weapon: null,
      caseLen: 0.0446,
      caseRadius: 0.00495,
      spin: 0,
    };
    this._pendingShots = 0;
    this._fireSeed = 0;

    // Deferred shell ejections (a case leaves the port a few ms after the shot).
    this._shellQueue = [];
    for (let i = 0; i < 8; i++) {
      this._shellQueue.push({ t: -1 });
    }
    this._droppedMags = [];
    this._state = {
      ads: false,
      sprint: false,
      lowReady: false,
      speed: 0,
      crouch: false,
      airborne: false,
      trigger: false,
      empty: false,
    };
    // Preallocated HUD snapshot handed to `ui` (see getHudState).
    this._hudState = {
      name: '', mode: 'auto', ammo: 0, reserve: 0, magSize: 0,
      reloading: false, reloadProgress: 0, ads: false, spread: 0, firing: false,
    };
  }

  /* ====================================================================== */
  /*  init                                                                  */
  /* ====================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    // 決定性: Math.random() 禁止 (ARCHITECTURE.md Hard rule 4)。必ず fork を持つ。
    this.rng = ctx.rng.fork();
    this.mats = new WeaponMaterials(ctx);
    this.sim = new ProjectileSim(ctx);
    this.viewmodel = new Viewmodel(ctx, this.mats);
    this.viewmodel.onClipEvent = (name, clip) => this._onClipEvent(name, clip);

    const t0 = performance.now();
    const builders = { rifle: buildRifle, smg: buildSmg, pistol: buildPistol };
    let tris = 0;
    for (const id of ['rifle', 'smg', 'pistol']) {
      const def = { ...WEAPON_DEFS[id] };
      def.cycleTime = 60 / def.rpm;
      const model = builders[id]();
      const entry = this.viewmodel.addWeapon(model, def);
      tris += entry.tris;
      this.states.set(id, {
        def,
        // 反動パターンは defs.js の patternSeed から決定的に生成される。
        pattern: buildRecoilPattern(def, Rng),
        mag: def.magSize,
        chambered: true,
        reserve: def.reserve,
        mode: def.modes[0],
        modeIndex: 0,
      });
    }
    this.viewmodel.setActive(this.activeId);
    this.viewmodel.play('draw');

    // Player hooks (all optional: the viewmodel works standalone).
    this.player = ctx.peek('player');
    this.physics = ctx.peek('physics');
    this._off = [];
    this._off.push(
      ctx.events.on('player:land', (e) => this.viewmodel.land(Math.abs(e?.velocity ?? 3)))
    );
    this._off.push(ctx.events.on('player:jump', () => this.viewmodel.jump()));

    this.stats = { tris, drawCalls: 0, live: 0, fired: 0 };
    console.info(
      `[weapons] ${this.states.size} weapons · ${(tris / 1000).toFixed(1)}k tris viewmodel · ` +
        `built in ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  /* ====================================================================== */
  /*  public getters                                                        */
  /* ====================================================================== */

  get state() {
    return this.states.get(this.activeId);
  }

  get current() {
    return this.state?.def ?? null;
  }

  get weaponIds() {
    return [...this.states.keys()];
  }

  get ammo() {
    const s = this.state;
    if (!s) return { mag: 0, chambered: false, reserve: 0, magSize: 0, total: 0, empty: true };
    const mag = s.mag;
    const ch = s.chambered ? 1 : 0;
    return {
      mag: mag + ch,
      inMag: mag,
      chambered: s.chambered,
      reserve: s.reserve,
      magSize: s.def.magSize,
      total: mag + ch + s.reserve,
      empty: mag + ch === 0,
    };
  }

  get fireMode() {
    return this.state?.mode ?? 'semi';
  }

  get adsProgress() {
    return this.viewmodel?.adsT ?? 0;
  }

  get reloading() {
    const n = this.viewmodel?.clipName;
    return n === 'reloadTac' || n === 'reloadEmpty';
  }

  get inspecting() {
    return this.viewmodel?.clipName === 'inspect';
  }

  get switching() {
    return this._switchTo !== null;
  }

  get firing() {
    return this._sinceShot < 0.12;
  }

  /** Current spread cone half-angle in degrees — the crosshair should use this. */
  get spreadDegrees() {
    return this._spread;
  }

  muzzleWorld(out) {
    return this.viewmodel.muzzleWorld(out ?? this._tmp);
  }

  /**
   * HUD adapter polled by `ui` every lateUpdate. Shape is fixed by the contract
   * documented at the top of src/ui/index.js; the object is preallocated and
   * mutated in place because `ui` reads it once per frame and never keeps it.
   */
  getHudState() {
    const h = this._hudState;
    const s = this.state;
    if (!s) return h;
    const a = this.ammo;
    const vm = this.viewmodel;
    h.name = s.def.label ?? s.def.id;
    h.mode = s.mode;
    // `a.mag` counts the chambered round; clamp the display to magSize.
    h.ammo = Math.min(a.mag, a.magSize);
    h.reserve = a.reserve;
    h.magSize = a.magSize;
    h.reloading = this.reloading;
    h.reloadProgress = h.reloading && vm?.clip?.duration
      ? Math.min(1, vm.clipT / vm.clip.duration)
      : 0;
    h.ads = (vm?.adsT ?? 0) > 0.5;
    // `ui` maps this to reticle bloom, so hand it a normalised 0..1.
    h.spread = Math.min(1, Math.max(0, this._spread / 6));
    h.firing = this.firing;
    return h;
  }

  /* ====================================================================== */
  /*  weapon management                                                     */
  /* ====================================================================== */

  setWeapon(id) {
    if (!this.states.has(id) || id === this.activeId || this._switchTo) return false;
    this._switchTo = id;
    this._switchTimer = this.viewmodel.play('holster');
    return true;
  }

  nextWeapon() {
    const ids = this.weaponIds;
    const i = ids.indexOf(this.activeId);
    return this.setWeapon(ids[(i + 1) % ids.length]);
  }

  cycleFireMode() {
    const s = this.state;
    if (!s || s.def.modes.length < 2) return s?.mode;
    s.modeIndex = (s.modeIndex + 1) % s.def.modes.length;
    s.mode = s.def.modes[s.modeIndex];
    this._burstLeft = 0;
    return s.mode;
  }

  reload() {
    const s = this.state;
    if (!s || this.reloading || this.switching) return false;
    if (s.mag >= s.def.magSize || s.reserve <= 0) return false;
    this.viewmodel.stopClip();
    const empty = s.mag === 0 && !s.chambered;
    this.viewmodel.play(empty ? 'reloadEmpty' : 'reloadTac');
    return true;
  }

  inspect() {
    if (this.reloading || this.switching || this.inspecting) return false;
    this.viewmodel.play('inspect');
    return true;
  }

  /* ====================================================================== */
  /*  firing                                                                */
  /* ====================================================================== */

  canFire() {
    const s = this.state;
    if (!s) return false;
    if (this.reloading || this.switching) return false;
    if (this._fireTimer > 0) return false;
    return s.chambered;
  }

  /** One round leaves the barrel. Returns false if the trigger clicked dry. */
  tryFire() {
    const s = this.state;
    if (!s) return false;
    if (this.reloading || this.switching || this._fireTimer > 0) return false;
    if (!s.chambered) {
      // Dry: lock the bolt back and let the player know by feel.
      this.viewmodel.boltHold = 1;
      this._fireTimer = 0.25;
      return false;
    }
    if (this.inspecting) this.viewmodel.stopClip();

    const def = s.def;
    const first = this._sinceShot > 0.35;
    // ---- feed the next round ----
    s.chambered = false;
    if (s.mag > 0) {
      s.mag--;
      s.chambered = true;
    } else {
      this.viewmodel.boltHold = 1;
    }

    // ---- deterministic recoil pattern ----
    const idx = Math.min(this._shotIndex, def.recoil.patternLength - 1);
    const pitch = s.pattern[idx * 2];
    const yaw = s.pattern[idx * 2 + 1];
    this._shotIndex++;

    // ---- aim: camera forward + a spread cone ----
    const cam = this.ctx.camera;
    cam.getDirectionToRef(this._LOCAL_FWD, this._camDir);
    this._camDir.normalize();
    this._dir.copyFrom(this._camDir);
    const spreadRad = this._spread * DEG;
    if (spreadRad > 1e-5) {
      const d = this.rng.disc(this._disc ?? (this._disc = { x: 0, y: 0 }));
      cam.getDirectionToRef(this._LOCAL_RIGHT, this._right);
      cam.getDirectionToRef(this._LOCAL_UP, this._up);
      this._right.scaleAndAddToRef(Math.tan(spreadRad) * d.x, this._dir);
      this._up.scaleAndAddToRef(Math.tan(spreadRad) * d.y, this._dir);
      this._dir.normalize();
    }

    // ---- projectile ----
    this.viewmodel.muzzleWorld(this._muzzle);
    const seed = this.rng.u32();
    this.sim.spawn({
      origin: this._muzzle,
      dir: this._dir,
      speed: def.muzzleVelocity,
      damage: def.damage,
      penetration: def.penetration,
      dragK: def.dragK,
      dropoff: def.dropoff,
      maxRange: def.maxRange,
      weapon: def,
      tracer: this.stats.fired % def.tracerEvery === 0,
    });

    // ---- feedback ----
    this.viewmodel.addRecoil(pitch, yaw, first);
    const p = this.player;
    if (p?.addRecoil) {
      // The camera climb is the learnable part; the viewmodel kick is the feel.
      p.addRecoil(pitch, yaw, def.recoil.roll * 0.35, def.recoil.punch);
    }
    this._spread = Math.min(def.spreadMax, this._spread + def.spreadPerShot);
    this._fireTimer = 60 / def.rpm;
    this._sinceShot = 0;
    this.stats.fired++;
    this._pendingShots++;
    this._fireSeed = seed;

    // Shell leaves the port shortly after the shot, once the bolt is back.
    this._queueShell(Math.min(0.05, this._fireTimer * 0.45));
    return true;
  }

  _queueShell(delay) {
    for (const q of this._shellQueue) {
      if (q.t < 0) {
        q.t = delay;
        return q;
      }
    }
    return null;
  }

  /* ====================================================================== */
  /*  reload / clip callbacks                                               */
  /* ====================================================================== */

  _onClipEvent(name, clipName) {
    const isReload = clipName === 'reloadTac' || clipName === 'reloadEmpty';
    switch (name) {
      case 'start':
        if (isReload) this._emitReload('start');
        break;
      case 'magout':
        if (isReload) this._emitReload('magout');
        break;
      case 'magdrop':
        if (isReload) this._dropMagazine();
        break;
      case 'magin':
        if (isReload) {
          this._emitReload('magin');
          this._completeReload(clipName === 'reloadEmpty');
        }
        break;
      case 'boltrelease':
        this.viewmodel.boltHold = 0;
        break;
      case 'end':
        if (isReload) {
          this._emitReload('end');
          this.viewmodel.boltHold = 0;
        }
        if (clipName === 'holster' && this._switchTo) {
          this.activeId = this._switchTo;
          this._switchTo = null;
          this.viewmodel.setActive(this.activeId);
          this.viewmodel.play('draw');
          this._shotIndex = 0;
          this._spread = 0;
        }
        break;
      default:
        break;
    }
  }

  /**
   * The chambered-round model: a tactical reload keeps the round in the chamber
   * and gives you magSize+1; an empty reload has to feed one out of the fresh
   * magazine, so you end up with exactly magSize.
   */
  _completeReload(empty) {
    const s = this.state;
    if (!s) return;
    const want = s.def.magSize - s.mag;
    const take = Math.min(want, s.reserve);
    s.reserve -= take;
    s.mag += take;
    if (empty && !s.chambered && s.mag > 0) {
      s.mag--;
      s.chambered = true;
    }
    this._shotIndex = 0;
  }

  _emitReload(phase) {
    this._reloadPayload.weapon = this.current;
    this._reloadPayload.phase = phase;
    this.ctx.events.emit('weapon:reload', this._reloadPayload);
  }

  /** Spawn the discarded magazine as a real rigid body in the world. */
  _dropMagazine() {
    const phys = this.physics ?? (this.physics = this.ctx.peek('physics'));
    const w = this.viewmodel.active;
    if (!w) return;
    const proxy = this._magProxy(w);
    if (!proxy) return;
    const mag = w.parts.magazine;
    mag.computeWorldMatrix(true);
    mag.getWorldMatrix().decompose(undefined, proxy.group.rotationQuaternion, proxy.group.position);
    proxy.group.setEnabled(true);
    // Magazine geometry hangs below its origin, so bias the body centre down.
    const half = w.magLen * 0.45;
    proxy.group.position.y -= half * 0.4;

    const vel = this._tmp.set(0, -0.7, 0);
    const pv = this.player?.velocity;
    if (pv) vel.addInPlace(pv);
    vel.x += this.rng.signed() * 0.25;
    vel.z += this.rng.signed() * 0.25;

    if (phys?.spawnDebris) {
      proxy.body = phys.spawnDebris(proxy.group.position, vel, {
        size: Math.max(0.02, w.magLen * 0.28),
        surface: 'rubber',
        mass: 0.38,
        lifetime: 22,
        mesh: proxy.group,
      });
      proxy.until = this.ctx.time.elapsed + 22;
    } else {
      proxy.until = this.ctx.time.elapsed + 2;
    }
  }

  /** Two reusable world-space magazine props per weapon. */
  _magProxy(w) {
    if (!this._magPools) this._magPools = new Map();
    let pool = this._magPools.get(w.id);
    if (!pool) {
      pool = [];
      for (let i = 0; i < 2; i++) {
        const group = new TransformNode(`dropped-mag-${w.id}-${i}`, this.ctx.scene);
        group.rotationQuaternion = new Quaternion();
        group.setEnabled(false);
        /**
         * physics.removeRigidBody は node を dispose する既定動作を持つ。
         * このプロキシはプールして使い回すので owKeep で保護する。
         */
        group.metadata = { owKeep: true };
        // Share the viewmodel's geometry and materials; world 側は影も落とす。
        for (const src of w.parts.magazine.getChildMeshes(false)) {
          const m = src.clone(`${group.name}-${src.name}`, group);
          m.renderingGroupId = this.ctx.RENDER_GROUP.WORLD;
          m.alwaysSelectAsActiveMesh = false;
          m.receiveShadows = true;
        }
        pool.push({ group, body: null, until: 0 });
        this._droppedMags.push(pool[i]);
      }
      this._magPools.set(w.id, pool);
    }
    // Reuse the oldest.
    let best = pool[0];
    for (const p of pool) if (p.until < best.until) best = p;
    if (best.body && this.physics?.removeRigidBody) this.physics.removeRigidBody(best.body);
    best.body = null;
    return best;
  }

  /* ====================================================================== */
  /*  frame                                                                 */
  /* ====================================================================== */

  fixedUpdate(h) {
    this.sim.fixedUpdate(h);
  }

  update(dt, ctx) {
    const s = this.state;
    if (!s) return;
    const def = s.def;
    const input = ctx.input;
    const player = this.player ?? (this.player = ctx.peek('player'));
    const st = this._state;

    this._sinceShot += dt;
    if (this._fireTimer > 0) this._fireTimer -= dt;
    if (this._burstCooldown > 0) this._burstCooldown -= dt;

    // ---- spread recovery -------------------------------------------------
    const rest = this._restSpread(def, player, st);
    this._spread = Math.max(rest, this._spread - def.spreadDecay * dt * (1 + this.adsProgress));
    if (this._sinceShot > 0.6) this._shotIndex = 0;

    // ---- gather state ----------------------------------------------------
    const live = !input.frozen && input.enabled !== false && this.debugMode === null;
    st.ads = live ? input.ads || player?.adsRequested === true : this.debugMode === 'ads';
    st.sprint = live ? player?.sprinting === true && this._sinceShot > 0.3 : false;
    st.speed = player?.horizontalSpeed ?? player?.speed ?? 0;
    st.crouch = player?.stance === 'crouch';
    st.airborne = player?.airborne === true;
    st.lowReady = player?.state === 'mantle' || player?.mantling === true;
    st.empty = s.mag === 0 && !s.chambered;

    // ---- input -----------------------------------------------------------
    if (live) {
      if (input.actionPressed('reload')) this.reload();
      if (input.pressed('KeyB')) this.cycleFireMode();
      if (input.pressed('KeyI')) this.inspect();
      if (input.pressed('Digit1')) this.setWeapon('rifle');
      if (input.pressed('Digit2')) this.setWeapon('smg');
      if (input.pressed('Digit3')) this.setWeapon('pistol');
      if (input.pressed('Tab')) this.nextWeapon();
      if (input.wheel) this.nextWeapon();
      this._runTrigger(dt, input.fire, input.firePressed, def, s);
      st.trigger = input.fire && this.canFire();
      // Auto-reload on a dry trigger pull, like every modern shooter.
      if (input.firePressed && st.empty) this.reload();
    } else if (this.debugMode) {
      this._runDebug(ctx);
      st.trigger = this._sinceShot < 0.09;
    }

    // Push the ADS curve to the player so camera FOV / move speed follow it.
    player?.setAdsProgress?.(this.viewmodel.adsT);

    this.stats.live = this.sim.stats.live;
    this.stats.fired = this.sim.stats.fired;
  }

  /** Fire-mode state machine. */
  _runTrigger(dt, held, pressed, def, s) {
    switch (s.mode) {
      case 'auto':
        if (held) this.tryFire();
        break;
      case 'burst':
        if (pressed && this._burstLeft === 0 && this._burstCooldown <= 0) {
          this._burstLeft = def.burstCount;
        }
        if (this._burstLeft > 0 && this._fireTimer <= 0) {
          if (this.tryFire()) {
            this._burstLeft--;
            this._fireTimer = 60 / def.burstRpm;
            if (this._burstLeft === 0) this._burstCooldown = def.burstDelay;
          } else {
            this._burstLeft = 0;
          }
        }
        break;
      default: // semi
        if (pressed) this.tryFire();
        break;
    }
  }

  _restSpread(def, player, st) {
    let base = lerp(def.spreadHip, def.spreadAds, this.adsProgress);
    if (st.crouch) base *= SPREAD_MODS.crouch;
    if (player?.stance === 'prone') base *= SPREAD_MODS.prone;
    if (st.speed < 0.4) base *= SPREAD_MODS.still;
    else if (st.speed > 3.2) base *= SPREAD_MODS.walking;
    if (st.sprint) base *= SPREAD_MODS.sprinting;
    if (st.airborne) base *= SPREAD_MODS.airborne;
    return base;
  }

  lateUpdate(dt, ctx) {
    const vm = this.viewmodel;
    if (!vm) return;
    vm.update(dt, this._state);

    // ---- muzzle flash / audio, now that the pose is final ---------------
    if (this._pendingShots > 0) {
      const def = this.current;
      vm.muzzleWorld(this._firePayload.origin);
      vm.boreDir(this._firePayload.dir);
      this._firePayload.weapon = def;
      this._firePayload.seed = this._fireSeed >>> 0;
      for (let i = 0; i < this._pendingShots; i++) {
        ctx.events.emit('weapon:fire', this._firePayload);
      }
      this._pendingShots = 0;
    }

    // ---- deferred shell ejection ---------------------------------------
    for (const q of this._shellQueue) {
      if (q.t < 0) continue;
      q.t -= dt;
      if (q.t > 0) continue;
      q.t = -1;
      vm.ejectWorld(this._shellPayload.position);
      vm.ejectVelocity(this._shellPayload.velocity, 2.3 + this.rng.float() * 1.2);
      const pv = this.player?.velocity;
      if (pv) this._shellPayload.velocity.addInPlace(pv);
      this._shellPayload.velocity.y += 1.1;
      this._shellPayload.weapon = this.current;
      const shell = vm.active?.shell;
      this._shellPayload.caseLen = shell?.caseLen ?? 0.0446;
      this._shellPayload.caseRadius = shell?.rimR ?? 0.00495;
      this._shellPayload.spin = 28 + this.rng.float() * 34;
      ctx.events.emit('weapon:shell', this._shellPayload);
    }

    // ---- retire dropped magazines --------------------------------------
    if (this._droppedMags.length) {
      const now = ctx.time.elapsed;
      for (const p of this._droppedMags) {
        if (p.group.isEnabled() && p.until && now > p.until) {
          p.group.setEnabled(false);
          if (p.body && this.physics?.removeRigidBody) {
            this.physics.removeRigidBody(p.body);
            p.body = null;
          }
        }
      }
    }
  }

  /* ====================================================================== */
  /*  capture harness                                                       */
  /* ====================================================================== */

  /**
   * Freeze the viewmodel in a photogenic state ('idle' | 'ads' | 'fire')。
   * ハーネスはショット適用後に settle フレームを送るので、'fire' は撮影される
   * フレーム付近で連射が続いているようイベントを散らしてある (Three 版の実測:
   * フラッシュコア寿命 52ms に対しシャッターの着地が数フレームぶれる)。
   */
  debugPose(kind = 'idle', opts = {}) {
    const vm = this.viewmodel;
    this.debugMode = kind;
    this.setWeaponImmediate('rifle');
    vm.stopClip();
    vm.recPos.reset();
    vm.recRot.reset();
    vm.settle.reset();
    vm.lag.reset();
    vm.lagRot.reset();
    vm.boltHold = 0;
    vm.boltCycle = 0;
    vm.sprintT = 0;
    vm.lowReadyT = 0;
    vm.bobPhase = 0;
    vm._angVel.yaw = 0;
    vm._angVel.pitch = 0;
    vm._hasPrev = false;
    // A fixed, non-zero noise phase: a settled but not artificially symmetric pose.
    vm.noiseT = 12.37;
    vm.debugFrozen = true;
    this._spread = kind === 'ads' ? 0.24 : 2.05;
    this._sinceShot = 10;
    this._debugFrame = 0;

    const s = this.state;
    if (s) {
      s.mag = kind === 'fire' ? 22 : s.def.magSize;
      s.chambered = true;
      s.reserve = s.def.reserve;
    }

    if (kind === 'ads') {
      vm.adsT = 1;
      this._state.ads = true;
    } else {
      vm.adsT = 0;
      this._state.ads = false;
    }
    this._state.sprint = false;
    this._state.speed = 0;
    this._state.trigger = false;
    if (kind === 'fire') {
      const grab = Math.round(opts?.grabFrame ?? 90);
      const frames = [grab - 26, grab - 19, grab - 12];
      for (let f = grab - 6; f <= grab + 18; f += 2) frames.push(f);
      this._scriptFrames = frames.filter((f) => f >= 2);
    } else {
      this._scriptFrames = null;
    }
    return kind;
  }

  /** Swap without the draw animation (harness + debug only). */
  setWeaponImmediate(id) {
    if (!this.states.has(id)) return false;
    this._switchTo = null;
    this.activeId = id;
    this.viewmodel.setActive(id);
    return true;
  }

  _runDebug(ctx) {
    this._debugFrame = (this._debugFrame ?? 0) + 1;
    const frames = this._scriptFrames;
    if (!frames) return;
    for (const f of frames) {
      if (f === this._debugFrame) {
        this._fireTimer = 0;
        this.tryFire();
      }
    }
  }

  /* ====================================================================== */

  resize() {}

  dispose() {
    for (const off of this._off ?? []) off();
    this.sim?.clear();
    for (const p of this._droppedMags) {
      if (p.body && this.physics?.removeRigidBody) this.physics.removeRigidBody(p.body);
      p.group.dispose();
    }
    this._droppedMags.length = 0;
    this.viewmodel?.dispose();
    this.mats?.dispose();
  }
}
