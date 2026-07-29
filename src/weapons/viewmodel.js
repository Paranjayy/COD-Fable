import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector.js';

import { Arm } from './hands.js';
import { buildClips, makeSampleResult } from './clips.js';
import { triCount, mergeAll, disk, diskRing, meshFromGeo } from './geometry.js';
import { quatXYZToRef, yawPitchFromQuat } from './vmath.js';
import {
  Spring,
  Spring3,
  Noise1,
  clamp,
  clamp01,
  lerp,
  damp,
  smootherstep,
  wrapPi,
  TAU,
} from './mathx.js';

/**
 * THE VIEWMODEL RIG — Babylon 移植版。
 *
 * アニメーションスタック (base / sway / bob / lag / recoil / clip) は Three 版から
 * 無改変で持ち越し。変わったのは**シーングラフの土台**だけ:
 *
 *   Three 版: 専用の viewScene + viewCamera (専用ライトリグ → README の 20 倍
 *             irradiance 事故の温床)
 *   この版:  world と同じ scene に置き、メッシュに renderingGroupId =
 *             RENDER_GROUP.VIEWMODEL を立てる。グループ手前で深度だけクリア
 *             されるので壁は貫通しない (core/engine.js の設計コメント参照)。
 *
 * 【重要・構成上の制約】
 *  - **ビューモデル専用のライトを追加しないこと。** world と同じ IBL・同じ露出で
 *    焼かれることがこの構成の目的そのもの。
 *  - 専用ニアクリップは無い。camera.minZ = 0.05 m より手前に置かない。
 *  - 専用 FOV も無い。ADS の FOV は player カメラが絞る (config.adsFovScale)。
 *    Three 版にあった viewFov (ビューモデルだけ別 FOV) は適用先が存在しないため
 *    落とした — ADS 時に武器が一緒に拡大されるのは織り込み済みの代償で、
 *    eyeRelief ベースの ADS ソルブが位置側で吸収する。
 *
 * The scene graph:
 *   scene
 *     anchor          <- copies the world camera transform every frame
 *       rig           <- the animation stack writes here
 *         weapon      <- body meshes + moving-part groups
 *         armL/armR   <- two-bone IK, hands welded to the weapon's grips
 *       reticle       <- collimated dot on the optical axis (camera space)
 */

const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix();
const _NEG_Z = new Vector3(0, 0, -1);
const _POS_Z = new Vector3(0, 0, 1);

/** Right-handed hand basis from a finger direction and a back-of-hand direction. */
function handBasis(out, finger, back) {
  _v.set(-finger[0], -finger[1], -finger[2]).normalize(); // hand +Z
  _v2.set(back[0], back[1], back[2]);
  _v.scaleAndAddToRef(-Vector3.Dot(_v2, _v), _v2);
  if (_v2.lengthSquared() < 1e-8) {
    _v2.set(0, 1, 0);
    _v.scaleAndAddToRef(-_v.y, _v2);
  }
  _v2.normalize(); // hand +Y
  Vector3.CrossToRef(_v2, _v, _v3);
  _v3.normalize(); // hand +X
  return Quaternion.RotationQuaternionFromAxisToRef(_v3, _v2, _v, out);
}

export class Viewmodel {
  constructor(ctx, mats) {
    this.ctx = ctx;
    this.mats = mats;
    this.rng = ctx.rng.fork();
    const scene = ctx.scene;
    this.scene = scene;
    this.RENDER_GROUP = ctx.RENDER_GROUP;

    this.anchor = new TransformNode('ow-viewmodel-anchor', scene);
    this.anchor.rotationQuaternion = new Quaternion();
    this.rig = new TransformNode('ow-viewmodel-rig', scene);
    this.rig.rotationQuaternion = new Quaternion();
    this.rig.parent = this.anchor;

    // ---- arms -------------------------------------------------------------
    const handMats = {
      glove: mats.get('glove'),
      pad: mats.get('glove_pad'),
      seam: mats.get('glove_seam'),
      sleeve: mats.get('sleeve'),
    };
    /**
     * Shoulder joints in CAMERA space (~200 mm lateral, ~210 mm below the eye)。
     * 後ろすぎると 630 mm の腕が届かず肘がロック、前すぎると上腕がニアクリップに
     * 入る — 数値の経緯は Three 版 hands.js の実測コメントに詳しい。
     */
    this.armR = new Arm(1, handMats, {
      scene,
      scale: 1,
      shoulderX: 0.205,
      shoulderY: -0.2,
      shoulderZ: 0.06,
      pose: 'grip',
    });
    this.armL = new Arm(-1, handMats, {
      scene,
      scale: 0.97,
      shoulderX: 0.2,
      shoulderY: -0.22,
      shoulderZ: 0.02,
      pose: 'clamp',
    });
    this.armR.root.parent = this.rig;
    this.armL.root.parent = this.rig;
    for (const arm of [this.armR, this.armL]) {
      for (const m of arm.root.getChildMeshes(false)) {
        m.renderingGroupId = this.RENDER_GROUP.VIEWMODEL;
        // 影は受けるが落とさない (CSM のカスケードには登録しない)。
        m.receiveShadows = true;
      }
    }
    // Body-fixed shoulders, camera space; re-based into rig space every frame.
    this.shoulderR = new Vector3(0.205, -0.2, 0.06);
    this.shoulderL = new Vector3(-0.2, -0.22, 0.02);

    // ---- reticle ----------------------------------------------------------
    /**
     * 2 MOA ドット + ハロー + 暗い縁取り + 12 分割リング。全部ユニット半径で
     * 作り `_updateReticle` が角サイズでまとめてスケールする (形が崩れない)。
     * 輝度・サイズの数値は Three 版で AgX の肩を測って決めたもの (ACES でも
     * 「白飛びさせず赤を保つ」方向は同じなので流用)。
     */
    this.reticle = new TransformNode('ow-reticle', scene);
    this.reticle.rotationQuaternion = new Quaternion();
    this.reticle.parent = this.anchor;
    const core = disk(1, 32);
    const halo = disk(1.6, 32);
    const rim = diskRing(1, 1.42, 32);
    const RING_SEGS = 12;
    const ringArcs = [];
    for (let i = 0; i < RING_SEGS; i++) {
      const a0 = (i / RING_SEGS) * TAU;
      ringArcs.push(diskRing(2.98, 3.42, 4, a0, (TAU / RING_SEGS) * 0.56));
    }
    const ringGeo = mergeAll(ringArcs);
    this.dotCore = meshFromGeo('ow-dot-core', core, mats.reticle(0xff1206, 0.95), scene);
    this.dotHalo = meshFromGeo('ow-dot-halo', halo, mats.reticle(0xff2a0c, 0.34), scene);
    this.dotRim = meshFromGeo('ow-dot-rim', rim, mats.reticleOutline(0.85), scene);
    this.dotRing = meshFromGeo('ow-dot-ring', ringGeo, mats.reticle(0xff1206, 0.95 * 0.5), scene);
    // 加算板の描画順 (Three の renderOrder 相当は alphaIndex)。
    this.dotHalo.alphaIndex = 19;
    this.dotRim.alphaIndex = 20;
    this.dotRing.alphaIndex = 20;
    this.dotCore.alphaIndex = 21;
    for (const m of [this.dotCore, this.dotHalo, this.dotRim, this.dotRing]) {
      m.parent = this.reticle;
      m.renderingGroupId = this.RENDER_GROUP.VIEWMODEL;
    }

    // ---- animation state --------------------------------------------------
    this.weapons = new Map();
    this.active = null;

    this.adsT = 0;
    this.adsTarget = 0;
    this.sprintT = 0;
    this.lowReadyT = 0;
    this.bobPhase = 0;
    this.stepT = 0;
    this.noiseT = 0;
    this.triggerT = 0;
    this.triggerTarget = 0;

    this.lag = new Spring3(5.4, 0.46);
    this.lagRot = new Spring3(6.2, 0.42);
    this.recPos = new Spring3(9, 0.42);
    this.recRot = new Spring3(9, 0.42);
    this.jumpSpring = new Spring(5.5, 0.5);
    this.landSpring = new Spring(7.5, 0.55);
    this.settle = new Spring3(2.2, 0.7);

    this.noise = [];
    for (let i = 0; i < 6; i++) this.noise.push(new Noise1(this.rng, 512));
    this.noiseRates = [0.13, 0.19, 0.271, 0.083, 0.117, 0.163];

    this._angVel = { yaw: 0, pitch: 0 };
    this._prevYaw = 0;
    this._prevPitch = 0;
    this._hasPrev = false;
    this._yp = { yaw: 0, pitch: 0 };

    // clip playback
    this.clip = null;
    this.clipT = 0;
    this.clipPrevT = 0;
    this.clipResult = makeSampleResult();
    this.onClipEvent = null;

    // moving-part drive
    this.boltCycle = 0; // 0..1, driven by firing
    this.boltHold = 0; // 1 = locked back (empty)
    this.magInHand = 0;
    this.magVisible = true;

    // preallocated working state
    this._basePos = new Vector3();
    this._baseQuat = new Quaternion();
    this._adsPos = new Vector3();
    this._adsQuat = new Quaternion();
    this._tmpPos = new Vector3();
    this._tmpQuat = new Quaternion();
    this._handPos = new Vector3();
    this._handQuat = new Quaternion();
    this._handPosL = new Vector3();
    this._handQuatL = new Quaternion();
    this._sightLocal = new Vector3();
    this._muzzleWorld = new Vector3();

    this.debugFrozen = false;
    /** キャプチャ以外でカメラ追従を切りたいハーネス用フック。 */
    this.trackCamera = true;
    this.rigOverride = null;
  }

  /* ====================================================================== */
  /*  construction                                                          */
  /* ====================================================================== */

  /**
   * Turn a model description (body + moving assemblies + nodes) into meshes.
   * One mesh per material per assembly: a whole rifle lands in 7-9 draw calls.
   */
  addWeapon(model, def) {
    const group = new TransformNode(`weapon-${model.id}`, this.scene);
    group.parent = this.rig;
    group.setEnabled(false);

    let tris = 0;
    const meshes = [];

    const build = (asm, parent) => {
      const map = asm.build();
      for (const [matKey, geo] of map) {
        const mesh = meshFromGeo(`${asm.name}-${matKey}`, geo, this.mats.get(matKey), this.scene);
        mesh.parent = parent;
        mesh.renderingGroupId = this.RENDER_GROUP.VIEWMODEL;
        /**
         * ビューモデルは CSM のキャスタには登録しない (カメラ直付けの影が地面を
         * 這うため) が、**受ける**のは必須 — 日陰で銃だけ日向は最悪の「貼り紙」。
         */
        mesh.receiveShadows = true;
        meshes.push(mesh);
        tris += triCount(geo);
      }
    };

    build(model.body, group);

    const parts = {};
    for (const [name, asm] of Object.entries(model.moving)) {
      const sub = new TransformNode(`${model.id}-${name}`, this.scene);
      sub.parent = group;
      build(asm, sub);
      parts[name] = sub;
    }

    // Seat the moving parts at their rest transforms.
    const n = model.nodes;
    // magazine だけはクォータニオン駆動 (_magFromHand の slerp が要るため)。
    if (parts.magazine) parts.magazine.rotationQuaternion = new Quaternion();
    if (parts.magazine && n.magSeat) applyNode(parts.magazine, n.magSeat);
    if (parts.charging && n.chargeRest) applyNode(parts.charging, n.chargeRest);
    if (parts.bolt && n.boltRest) applyNode(parts.bolt, n.boltRest);
    if (parts.slide && n.slideRest) applyNode(parts.slide, n.slideRest);
    if (parts.trigger && n.triggerPivot) applyNode(parts.trigger, n.triggerPivot);
    if (parts.selector && n.selectorPivot) applyNode(parts.selector, n.selectorPivot);

    const entry = {
      id: model.id,
      def,
      model,
      group,
      parts,
      meshes,
      tris,
      clips: buildClips(model.nodes, def),
      sight: Vector3.FromArray(model.nodes.sight),
      ironSight: Vector3.FromArray(model.nodes.ironSight ?? model.nodes.sight),
      muzzle: Vector3.FromArray(model.nodes.muzzle),
      eject: Vector3.FromArray(model.nodes.eject),
      ejectDir: Vector3.FromArray(model.nodes.ejectDir ?? [1, 0.4, 0.2]).normalize(),
      optic: model.nodes.opticGlass ?? null,
      magSeatPos: Vector3.FromArray(model.nodes.magSeat.pos),
      magSeatQuat: quatXYZToRef(
        model.nodes.magSeat.rot[0],
        model.nodes.magSeat.rot[1],
        model.nodes.magSeat.rot[2],
        new Quaternion()
      ),
      gripR: model.nodes.gripR,
      gripL: model.nodes.gripL,
      chargePull: Vector3.FromArray(model.nodes.chargePull ?? [0, 0, 0]),
      boltTravel: Vector3.FromArray(model.nodes.boltTravel ?? [0, 0, 0]),
      slideTravel: Vector3.FromArray(model.nodes.slideTravel ?? [0, 0, 0]),
      triggerPull: model.nodes.triggerPull ?? -0.3,
      magLen: model.magSize?.len ?? 0.2,
      shell: model.shell,
      lhandPose: model.id === 'pistol' ? 'cup' : 'clamp',
    };
    this._fitSupportHand(entry);
    this.weapons.set(model.id, entry);
    return entry;
  }

  /**
   * GROUND THE SUPPORT HAND ON THE HANDGUARD — once, at build time.
   *
   * Three 版はここで (1) 指先の接触ソルブ (2) 接触 AO の頂点カラー焼き込み を
   * やっていた。(2) は頂点マスクシェーダごと Babylon 版に存在しないので落とし、
   * ポーズ品質を決める (1) だけを残す。
   */
  _fitSupportHand(w) {
    const hg = w.model.nodes.handguard;
    const gL = w.gripL;
    if (!hg || !gL || w.id === 'pistol') return;
    this._handPosL.set(gL.pos[0], gL.pos[1], gL.pos[2]);
    handBasis(this._handQuatL, gL.finger ?? [0.82, 0.5, -0.28], gL.back ?? [-0.5, 0.32, -0.8]);
    const poseName = `clamp:${w.id}`;
    this.armL.setPose('clamp');
    this.armL.fitToCylinder(this._handPosL, this._handQuatL, hg.axis, hg.dir, hg.r, {
      clearance: 0.001,
      poseName,
    });
    w.lhandPose = poseName;
    this.armL.setPose(poseName);
  }

  setActive(id) {
    const w = this.weapons.get(id);
    if (!w || w === this.active) return this.active;
    if (this.active) this.active.group.setEnabled(false);
    this.active = w;
    w.group.setEnabled(true);
    this.recPos.reset();
    this.recRot.reset();
    this.settle.reset();
    this.boltCycle = 0;
    this.boltHold = 0;
    this.magInHand = 0;
    this.magVisible = true;
    this.armR.setPose('grip');
    // The FITTED clamp for this weapon, not the authored one.
    this.armL.setPose(w.lhandPose ?? (id === 'pistol' ? 'cup' : 'clamp'));
    return w;
  }

  /* ====================================================================== */
  /*  clip playback                                                         */
  /* ====================================================================== */

  play(name) {
    const w = this.active;
    if (!w) return 0;
    const clip = w.clips[name];
    if (!clip) return 0;
    this.clip = clip;
    this.clipT = 0;
    this.clipPrevT = -1;
    return clip.duration;
  }

  stopClip() {
    this.clip = null;
    this.clipResult.active = false;
    this.clipResult.lhand.weight = 0;
  }

  get clipPlaying() {
    return this.clip !== null;
  }

  get clipName() {
    return this.clip?.name ?? null;
  }

  /* ====================================================================== */
  /*  impulses                                                              */
  /* ====================================================================== */

  /**
   * Per-shot viewmodel kick. `pitch`/`yaw` are the aim-space recoil for this
   * shot (from the deterministic pattern) so the visual climb matches where the
   * bullets are actually going.
   */
  addRecoil(pitch, yaw, first = false) {
    const w = this.active;
    if (!w) return;
    const r = w.def.recoil;
    const ads = this.adsT;
    const scale = lerp(1, 0.54, ads) * (first ? 1.18 : 1);
    const jitter = 0.86 + this.rng.float() * 0.3;
    this.recPos.f = r.freq;
    this.recPos.z = r.damping;
    this.recRot.f = r.freq * 0.92;
    this.recRot.z = r.damping;
    // A velocity impulse of v0 on a spring of angular frequency w peaks at
    // roughly v0/w, so the kick amplitudes below are in real metres/radians.
    const wp = TAU * this.recPos.f;
    const wr = TAU * this.recRot.f;
    this.recPos.kick(
      this.rng.signed() * r.kickBack * 0.2 * scale * wp,
      r.kickUp * scale * jitter * wp,
      r.kickBack * scale * jitter * wp
    );
    this.recRot.kick(
      (pitch * 5.5 + r.pitch * 1.4) * scale * jitter * wr,
      (-yaw * 4.5 - this.rng.signed() * r.yaw * 0.8) * scale * wr,
      (this.rng.signed() * 0.4 + 0.6) * r.roll * scale * wr
    );
    const ws = TAU * this.settle.f;
    this.settle.kick(
      this.rng.signed() * 0.0012 * scale * ws,
      0.0018 * scale * ws,
      this.rng.signed() * 0.003 * scale * ws
    );
    this.boltCycle = 1;
  }

  jump() {
    this.jumpSpring.kick(-1.2);
  }

  land(speed = 3) {
    this.landSpring.kick(clamp(speed * 0.45, 0.4, 3.4));
  }

  /* ====================================================================== */
  /*  frame update                                                          */
  /* ====================================================================== */

  /**
   * @param {number} dt
   * @param {object} s  { ads, sprint, lowReady, speed, crouch, airborne,
   *                      trigger, empty }
   */
  update(dt, s) {
    const w = this.active;
    if (!w) return;
    const def = w.def;
    // Defensive: a non-positive or absurd dt would integrate the whole
    // animation stack backwards (a negative step snaps ADS straight to 1).
    dt = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0;

    /* -------- camera-relative anchor ---------------------------------- */
    const cam = this.ctx.camera;
    if (this.trackCamera) {
      /**
       * カメラのワールド行列 (= view の逆行列) をそのまま貰う。RH ビュー行列
       * なのでカメラ空間は GL 流 (-Z 前方 / +X 右 / +Y 上) — defs.js の
       * ポーズ数値 (Three 規約) がそのまま通る根拠。
       */
      cam.getWorldMatrix().decompose(undefined, this.anchor.rotationQuaternion, this.anchor.position);
    }
    this.anchor.computeWorldMatrix(true);

    /* -------- angular velocity for the lag layer ---------------------- */
    yawPitchFromQuat(this.anchor.rotationQuaternion, this._yp);
    const yaw = this._yp.yaw;
    const pitch = this._yp.pitch;
    if (this._hasPrev && dt > 1e-5) {
      const dy = wrapPi(yaw - this._prevYaw) / dt;
      const dp = wrapPi(pitch - this._prevPitch) / dt;
      // Low-pass, then clamp: a teleport must not throw the gun off screen.
      this._angVel.yaw = damp(this._angVel.yaw, clamp(dy, -9, 9), 18, dt);
      this._angVel.pitch = damp(this._angVel.pitch, clamp(dp, -9, 9), 18, dt);
    } else {
      this._angVel.yaw = 0;
      this._angVel.pitch = 0;
    }
    this._prevYaw = yaw;
    this._prevPitch = pitch;
    this._hasPrev = true;

    /* -------- blends --------------------------------------------------- */
    const adsRate = 1 / Math.max(0.05, def.adsTime);
    const wantAds = this.clip && this.clip.name !== 'draw' ? 0 : s.ads ? 1 : 0;
    this.adsTarget = wantAds;
    // Linear rate with a smootherstep shaping: a spring here reads as mushy.
    this.adsT = clamp01(this.adsT + (wantAds ? adsRate : -adsRate * 1.25) * dt);
    const ads = smootherstep(0, 1, this.adsT);

    const sprintTarget = s.sprint && !this.clip ? 1 : 0;
    this.sprintT = damp(this.sprintT, sprintTarget, 9, dt);
    this.lowReadyT = damp(this.lowReadyT, s.lowReady ? 1 : 0, 8, dt);

    this.triggerTarget = s.trigger ? 1 : 0;
    this.triggerT = damp(this.triggerT, this.triggerTarget, 26, dt);

    /* -------- base pose ------------------------------------------------ */
    const hipP = def.hipPos;
    const hipR = def.hipRot;
    this._basePos.set(hipP[0], hipP[1], hipP[2]);
    quatXYZToRef(hipR[0], hipR[1], hipR[2], this._baseQuat);

    // Sprint / low-ready poses replace the hip pose.
    if (this.sprintT > 1e-3) {
      const p = def.sprintPos;
      const r = def.sprintRot;
      this._tmpPos.set(p[0], p[1], p[2]);
      quatXYZToRef(r[0], r[1], r[2], this._tmpQuat);
      Vector3.LerpToRef(this._basePos, this._tmpPos, this.sprintT, this._basePos);
      Quaternion.SlerpToRef(this._baseQuat, this._tmpQuat, this.sprintT, this._baseQuat);
    }
    if (this.lowReadyT > 1e-3) {
      const p = def.lowReadyPos;
      const r = def.lowReadyRot;
      this._tmpPos.set(p[0], p[1], p[2]);
      quatXYZToRef(r[0], r[1], r[2], this._tmpQuat);
      Vector3.LerpToRef(this._basePos, this._tmpPos, this.lowReadyT, this._basePos);
      Quaternion.SlerpToRef(this._baseQuat, this._tmpQuat, this.lowReadyT, this._baseQuat);
    }

    /* -------- ADS pose: solved, not authored --------------------------- */
    if (ads > 1e-4) {
      const cant = def.adsCant;
      quatXYZToRef(cant[0], cant[1], cant[2], this._adsQuat);
      // sight point in rig space, then the translation that lands it on axis
      this._sightLocal.copyFrom(w.sight);
      this._sightLocal.rotateByQuaternionToRef(this._adsQuat, this._sightLocal);
      this._adsPos.set(0, 0, -def.eyeRelief).subtractInPlace(this._sightLocal);
      Vector3.LerpToRef(this._basePos, this._adsPos, ads, this._basePos);
      Quaternion.SlerpToRef(this._baseQuat, this._adsQuat, ads, this._baseQuat);
    }

    /* -------- additive layers ------------------------------------------ */
    const swayScale = def.swayScale * lerp(1, 0.22, ads) * lerp(1, 1.5, this.sprintT);
    this.noiseT += dt;
    const n = this.noise;
    const nr = this.noiseRates;
    const t = this.noiseT;
    // Layered, incommensurate rates: the pattern does not repeat in a session.
    const swayX = n[0].fbm(t * nr[0], 3) * 0.55 + n[3].fbm(t * nr[3] * 2.3, 2) * 0.45;
    const swayY = n[1].fbm(t * nr[1], 3) * 0.55 + n[4].fbm(t * nr[4] * 2.1, 2) * 0.45;
    const swayZ = n[2].fbm(t * nr[2], 2) * 0.6 + n[5].fbm(t * nr[5] * 1.7, 2) * 0.4;
    // Breathing: a slow cycle under the noise.
    const breath = Math.sin(t * 1.38) * 0.5 + Math.sin(t * 0.61 + 1.1) * 0.25;

    let px = swayX * 0.0075 * swayScale;
    let py = (swayY * 0.006 + breath * 0.0022) * swayScale;
    let pz = swayZ * 0.004 * swayScale;
    let rx = (swayY * 0.021 + breath * 0.006) * swayScale;
    let ry = swayX * 0.028 * swayScale;
    let rz = swayZ * 0.017 * swayScale;

    /* -------- movement bob --------------------------------------------- */
    const speed = s.speed ?? 0;
    const bobAmt =
      def.bobScale * clamp01(speed / 4.2) * lerp(1, 0.28, ads) * (s.airborne ? 0.25 : 1);
    if (speed > 0.05) {
      this.bobPhase += dt * (3.1 + speed * 0.72) * (s.sprint ? 1.05 : 1);
      if (this.bobPhase > TAU * 64) this.bobPhase -= TAU * 64;
    }
    const bp = this.bobPhase;
    px += Math.sin(bp) * 0.0165 * bobAmt;
    py += (Math.abs(Math.cos(bp)) - 0.6) * 0.0125 * bobAmt;
    pz += Math.sin(bp * 2) * 0.0055 * bobAmt;
    rz += Math.sin(bp) * 0.031 * bobAmt;
    rx += Math.cos(bp * 2) * 0.014 * bobAmt;
    ry += Math.sin(bp + 0.6) * 0.019 * bobAmt;

    /* -------- weapon lag ---------------------------------------------- */
    const lagScale = lerp(1, 0.42, ads);
    const av = this._angVel;
    this.lag.step(
      dt,
      clamp(-av.yaw * 0.019, -0.05, 0.05) * lagScale,
      clamp(av.pitch * 0.014, -0.04, 0.04) * lagScale,
      clamp(-Math.abs(av.yaw) * 0.006, -0.03, 0.03) * lagScale
    );
    this.lagRot.step(
      dt,
      clamp(-av.pitch * 0.075, -0.24, 0.24) * lagScale,
      clamp(av.yaw * 0.085, -0.3, 0.3) * lagScale,
      clamp(-av.yaw * 0.055, -0.2, 0.2) * lagScale
    );
    px += this.lag.x;
    py += this.lag.y;
    pz += this.lag.z;
    rx += this.lagRot.x;
    ry += this.lagRot.y;
    rz += this.lagRot.z;

    /* -------- recoil + settle ----------------------------------------- */
    this.recPos.step(dt, 0, 0, 0);
    this.recRot.step(dt, 0, 0, 0);
    this.settle.step(dt, 0, 0, 0);
    px += this.recPos.x;
    py += this.recPos.y;
    pz += this.recPos.z;
    rx += this.recRot.x + this.settle.y;
    ry += this.recRot.y + this.settle.x;
    rz += this.recRot.z + this.settle.z;

    /* -------- jump / land --------------------------------------------- */
    this.jumpSpring.step(dt, 0);
    this.landSpring.step(dt, 0);
    py -= this.landSpring.x * 0.014 + this.jumpSpring.x * 0.006;
    rx -= this.landSpring.x * 0.05;

    /* -------- clip (reload / inspect / draw) -------------------------- */
    const res = this.clipResult;
    if (this.clip) {
      this.clipT += dt;
      const c = this.clip;
      const tt = clamp(this.clipT, 0, c.duration);
      c.sample(tt, res);
      for (const ev of c.events) {
        if (ev.t > this.clipPrevT && ev.t <= tt) this.onClipEvent?.(ev.name, c.name);
      }
      this.clipPrevT = tt;
      px += res.pos[0];
      py += res.pos[1];
      pz += res.pos[2];
      rx += res.rot[0];
      ry += res.rot[1];
      rz += res.rot[2];
      if (this.clipT >= c.duration) {
        this.stopClip();
      }
    }

    /* -------- compose -------------------------------------------------- */
    this.rig.position.set(this._basePos.x + px, this._basePos.y + py, this._basePos.z + pz);
    quatXYZToRef(rx, ry, rz, _q);
    // Three 版の rig.quaternion.copy(base).multiply(q) と同じ合成順 (base ⊗ 加算層)。
    this._baseQuat.multiplyToRef(_q, this.rig.rotationQuaternion);
    if (this.rigOverride) {
      this.rig.position.copyFrom(this.rigOverride.position);
      this.rig.rotationQuaternion.copyFrom(this.rigOverride.rotationQuaternion);
    }
    this.rig.computeWorldMatrix(true);

    /* -------- hands (first: the magazine can be held by one) ---------- */
    this._solveHands(w, res);

    /* -------- moving parts -------------------------------------------- */
    this._updateParts(w, dt, s, res);

    /* -------- reticle -------------------------------------------------- */
    this._updateReticle(w, ads);
  }

  /* ---------------------------------------------------------------------- */

  _updateParts(w, dt, s, res) {
    const p = w.parts;

    // Bolt / slide cycle: a fast rearward stroke and a slightly slower return.
    if (this.boltCycle > 0) {
      const cycle = Math.max(0.045, (w.def.cycleTime ?? 60 / w.def.rpm) * 0.62);
      this.boltCycle = Math.max(0, this.boltCycle - dt / cycle);
    }
    const cyc = this.boltCycle;
    // 1 -> 0 over the cycle: out fast, back with a small bounce.
    const stroke = cyc > 0.55 ? (1 - cyc) / 0.45 : cyc / 0.55;
    const clipBolt = res.active ? res.parts.bolt : 0;
    const boltOff = Math.max(stroke, this.boltHold, clipBolt * this.boltHold);

    if (p.bolt) {
      p.bolt.position.set(
        w.model.nodes.boltRest.pos[0] + w.boltTravel.x * boltOff,
        w.model.nodes.boltRest.pos[1] + w.boltTravel.y * boltOff,
        w.model.nodes.boltRest.pos[2] + w.boltTravel.z * boltOff
      );
    }
    if (p.slide) {
      p.slide.position.set(
        w.model.nodes.slideRest.pos[0] + w.slideTravel.x * boltOff,
        w.model.nodes.slideRest.pos[1] + w.slideTravel.y * boltOff,
        w.model.nodes.slideRest.pos[2] + w.slideTravel.z * boltOff
      );
    }
    if (p.charging) {
      const pull = res.active ? res.parts.charge : 0;
      const rest = w.model.nodes.chargeRest.pos;
      p.charging.position.set(
        rest[0] + w.chargePull.x * pull,
        rest[1] + w.chargePull.y * pull,
        rest[2] + w.chargePull.z * pull
      );
    }
    if (p.trigger) {
      p.trigger.rotation.x = w.triggerPull * this.triggerT;
    }
    if (p.selector) {
      p.selector.rotation.x = lerp(-0.95, 0, clamp01(this.selectorLive ?? 1));
    }

    // Magazine: seated, in the support hand, or hidden.
    if (p.magazine) {
      const inHand = res.active ? res.parts.mag : 0;
      this.magVisible = res.active ? res.parts.magVisible : true;
      p.magazine.setEnabled(this.magVisible);
      if (inHand > 1e-4) {
        this._magFromHand(w, p.magazine, inHand);
      } else {
        p.magazine.position.copyFrom(w.magSeatPos);
        p.magazine.rotationQuaternion.copyFrom(w.magSeatQuat);
      }
    }
  }

  _magFromHand(w, magGroup, weight) {
    // The hand target is a WRIST in weapon space: offset into the palm (62 mm
    // along the hand's -Z) before the along-the-magazine offset.
    _q.copyFrom(this._handQuatL);
    _v.copyFrom(this._handPosL);
    _v2.set(0, w.magLen * 0.62, -0.062);
    _v2.rotateByQuaternionToRef(_q, _v2);
    _v.addInPlace(_v2);
    Vector3.LerpToRef(w.magSeatPos, _v, weight, magGroup.position);
    Quaternion.SlerpToRef(w.magSeatQuat, _q, weight, magGroup.rotationQuaternion);
  }

  _solveHands(w, res) {
    // Shoulders are body-fixed: express the camera-space anchor in rig space.
    this.rig.rotationQuaternion.conjugateToRef(_q);
    _v.copyFrom(this.shoulderR).subtractInPlace(this.rig.position);
    _v.rotateByQuaternionToRef(_q, _v);
    this.armR.shoulder.copyFrom(_v);
    _v.copyFrom(this.shoulderL).subtractInPlace(this.rig.position);
    _v.rotateByQuaternionToRef(_q, _v);
    this.armL.shoulder.copyFrom(_v);

    // ---- shooting hand: welded to the grip ----
    const gR = w.gripR;
    this._handPos.set(gR.pos[0], gR.pos[1], gR.pos[2]);
    handBasis(this._handQuat, gR.finger ?? [0, -0.35, -0.94], gR.back ?? [0.95, 0.25, 0.18]);
    this.armR.solve(this._handPos, this._handQuat);
    this.armR.setTrigger(this.triggerT);

    // ---- support hand: grip, or wherever the clip puts it ----
    const gL = w.gripL;
    let pos = gL.pos;
    let finger = gL.finger ?? [0.82, 0.5, -0.28];
    let back = gL.back ?? [-0.5, 0.32, -0.8];
    let pose = w.lhandPose ?? (w.id === 'pistol' ? 'cup' : 'clamp');
    if (res.active && res.lhand.weight > 0.5) {
      pos = res.lhand.pos;
      finger = res.lhand.finger;
      back = res.lhand.back;
      pose = res.lhand.pose;
    }
    this._handPosL.set(pos[0], pos[1], pos[2]);
    handBasis(this._handQuatL, finger, back);
    if (pose !== this.armL.pose) this.armL.setPose(pose);
    this.armL.solve(this._handPosL, this._handQuatL);
  }

  /**
   * The collimated dot — レティクルは光学的無限遠にあるので、見かけの方向は
   * チューブ軸そのもの。スプライトをガラスに貼らずこれを再現するから、武器が
   * 揺れてもドットは照準点に残り、斜めから覗くとビネットで消える。
   */
  _updateReticle(w, ads) {
    const optic = w.optic;
    if (!optic) {
      this.reticle.setEnabled(false);
      return;
    }
    // Optic axis and lens centre, both in camera (anchor) space.
    _v.set(optic.center[0], optic.center[1], optic.center[2]);
    _v.rotateByQuaternionToRef(this.rig.rotationQuaternion, _v);
    _v.addInPlace(this.rig.position);
    _v3.copyFrom(_NEG_Z);
    _v3.rotateByQuaternionToRef(this.rig.rotationQuaternion, _v3);
    _v3.normalize();

    // Where the axis ray from the eye crosses the lens plane.
    const s = Vector3.Dot(_v, _v3);
    if (s <= 0.02) {
      this.reticle.setEnabled(false);
      return;
    }
    _v2.copyFrom(_v3).scaleInPlace(s); // dot position in camera space
    const offX = _v2.x - _v.x;
    const offY = _v2.y - _v.y;
    const off = Math.hypot(offX, offY);
    const apertureR = optic.apertureR ?? 0.01;
    let alpha = 1 - smootherstep(apertureR * 0.5, apertureR * 1.05, off);
    alpha *= lerp(0.55, 1, ads); // brighter once the eye is behind the glass

    if (alpha <= 0.01) {
      this.reticle.setEnabled(false);
      return;
    }
    this.reticle.setEnabled(true);
    this.reticle.position.copyFrom(_v2);
    // 板 (+Z 法線) を目 (カメラ空間原点) に向ける。
    _v3.copyFrom(_v2).scaleInPlace(-1 / Math.max(1e-6, _v2.length()));
    Quaternion.FromUnitVectorsToRef(_POS_Z, _v3, this.reticle.rotationQuaternion);
    /**
     * SIZE: 幾何学的に正直な 2 MOA は 0.6 px (死んだサブピクセル) なので、
     * 市販のダットサイトと同じ方向にチートする — 判読できるサイズで描き、
     * 目がガラスに近づくほど育てる。hip 4 px / ADS 7.9 px 半径。
     */
    const coreR = s * lerp(0.00385, 0.00655, ads);
    this.dotCore.scaling.setAll(coreR);
    this.dotRim.scaling.setAll(coreR);
    this.dotHalo.scaling.setAll(coreR);
    this.dotRing.scaling.setAll(coreR);
    this.dotCore.material.alpha = alpha;
    this.dotRim.material.alpha = alpha * 0.8;
    this.dotRing.material.alpha = alpha;
    // The halo is a bloom seed, not a glow.
    this.dotHalo.material.alpha = alpha * 0.06;
  }

  /* ====================================================================== */
  /*  world-space queries for firing                                        */
  /* ====================================================================== */

  /** Muzzle position in WORLD space (for the flash and the shell). */
  muzzleWorld(out) {
    const w = this.active;
    if (!w) return out.set(0, 0, 0);
    w.group.computeWorldMatrix(true);
    Vector3.TransformCoordinatesToRef(w.muzzle, w.group.getWorldMatrix(), out);
    return out;
  }

  ejectWorld(out) {
    const w = this.active;
    if (!w) return out.set(0, 0, 0);
    w.group.computeWorldMatrix(true);
    Vector3.TransformCoordinatesToRef(w.eject, w.group.getWorldMatrix(), out);
    return out;
  }

  ejectVelocity(out, speed = 2.6) {
    const w = this.active;
    if (!w) return out.set(0, 0, 0);
    w.group.computeWorldMatrix(true);
    Vector3.TransformNormalToRef(w.ejectDir, w.group.getWorldMatrix(), out);
    out.normalize().scaleInPlace(speed);
    return out;
  }

  /** Bore direction in world space. */
  boreDir(out) {
    const w = this.active;
    if (!w) return out.set(0, 0, -1);
    w.group.computeWorldMatrix(true);
    Vector3.TransformNormalToRef(_NEG_Z, w.group.getWorldMatrix(), out);
    return out.normalize();
  }

  dispose() {
    // anchor 以下 (rig / weapons / arms / reticle) を再帰破棄。
    // マテリアルは WeaponMaterials が所有しているのでここでは触らない。
    this.anchor.dispose(false, false);
    this.weapons.clear();
  }
}

function applyNode(obj, node) {
  obj.position.set(node.pos[0], node.pos[1], node.pos[2]);
  if (node.rot) {
    if (obj.rotationQuaternion) quatXYZToRef(node.rot[0], node.rot[1], node.rot[2], obj.rotationQuaternion);
    else obj.rotation.set(node.rot[0], node.rot[1], node.rot[2]);
  }
}
