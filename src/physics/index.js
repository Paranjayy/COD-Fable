/**
 * PHYSICS — Havok (WASM) backed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * このファイルは Three.js 版の自前実装 (bvh.js / character.js / rigidbody.js /
 * ragdoll.js / debug.js = 約 5.6k 行) を置き換えるものです。
 *
 * 置き換えの理由は「短く書けるから」ではなく、**自前実装が抱えていた問題が
 * Havok では構造的に発生しないから**:
 *
 *   - binned-SAH BVH の再構築 (29k tris → 14k nodes / 22 ms) を自分で管理する
 *     必要がなくなる。Havok は静的ボディの追加/削除を内部で増分処理する。
 *   - swept-capsule の 5-plane crease stack を自分で解く必要がなくなる。
 *     Babylon の PhysicsCharacterController が simplex solver + step-up sweep を
 *     持っており、階段・傾斜・薄壁の扱いが実装済み。
 *   - CCD、拘束ソルバが実績のある実装になる。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 決定性について — このリポジトリで最も重要な性質
 * ────────────────────────────────────────────────────────────────────────────
 * README にある通り、このプロジェクトの中核資産は「キャプチャが bit-identical
 * であること」で、それにより imagediff.mjs が pixel gate として機能している。
 * 物理が非決定的だとその土台が崩れるため、以下を守る:
 *
 *   1. **Havok の自動ステップを止める** (`setTimeStep(0)`)。Babylon は既定で
 *      scene.render() の中で実フレーム時間を使って物理を進めてしまう。それでは
 *      フレームレートが変われば結果が変わる。ここでは engine の fixedUpdate から
 *      固定 1/120 s で明示的に `_step()` を呼ぶ。
 *   2. **乱数は必ず ctx.rng 経由**。弾道の偏向やデブリの初速に Math.random() を
 *      使うと ARCHITECTURE.md Hard rule 4 に違反し、キャプチャが揺れる。
 *   3. **サブステップ数は engine 側で MAX_SUBSTEPS に制限済み**。積み残しは
 *      捨てられるので、重いフレームがあっても物理が「まとめて進む」ことはない。
 *
 * 注意: Havok 自体はクロスプラットフォームでの bit-identical を保証しない
 * (浮動小数の丸めが CPU 命令セットに依存しうる)。**同一マシン・同一ブラウザでの
 * run-to-run 再現性**は上記で担保できるが、CI のマシンを変えたらベースラインは
 * 撮り直しが必要。これは Three 版の自前実装でも同じだったが、あちらは全演算が
 * JS だったぶん移植性は高かった — 移行による明確なトレードオフとして記録する。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API  —  const phys = ctx.get('physics')
 * ────────────────────────────────────────────────────────────────────────────
 * STATIC WORLD
 *   addStatic(mesh, surfaceType?, opts?)   -> handle
 *   addStaticGroup(root, surfaceType?)     -> handle[]   子孫を走査
 *   removeStatic(handle)
 *
 * QUERIES  (world 空間, メートル。dir は正規化されていなくてよい)
 *   raycast(origin, dir, maxDist, mask?)   -> Hit  (常にオブジェクト。.hit を見る)
 *   raycastAny(origin, dir, maxDist, mask?)-> bool
 *   lineOfSight(from, to, mask?)           -> bool
 *   sphereCast(origin, dir, radius, maxDist, mask?)  -> Hit
 *   capsuleCast(p0, p1, radius, dir, maxDist, mask?) -> Hit
 *   overlapSphere(center, radius, mask?)   -> 接触数
 *   checkCapsule(p0, p1, radius, mask?)    -> bool (true = 空いている)
 *   groundHeight(x, z, fromY?, mask?)      -> 床の y、無ければ -Infinity
 *
 *   Hit = { hit, point, normal, distance, fraction, surface, surfaceIndex,
 *           object, body, actor, part }
 *   レコードは 64 深のリングプール。**今すぐ読むかコピーする**こと。溜め込まない。
 *
 * CHARACTER
 *   createCharacter({radius, height, position, stepHeight, slopeLimit}) -> Character
 *   removeCharacter(c)
 *   c.move(dx,dy,dz) / c.position / c.velocity / c.grounded / c.groundNormal
 *   c.groundSurfaceName / c.touchingCeiling / c.setHeight(h) / c.canFit(h)
 *   c.teleport(x,y,z) / c.landingSpeed / c.lastMoveBlocked
 *
 * BALLISTICS
 *   fireBullet({origin, dir, damage, penetration, maxDist, mask, rng}) -> impacts[]
 *   貫通した層の **入口と出口の両方** で `bullet:impact` を emit する。
 *   explode({position, radius, damage, impulse})
 *
 * DYNAMICS
 *   addRigidBody({shape, halfExtents|radius, mass, position, velocity, mesh}) -> RigidBody
 *   spawnDebris(position, velocity, {size, surface, lifetime, mesh})
 *   removeRigidBody(b) / b.applyImpulse(ix,iy,iz, px,py,pz)
 *   registerBodyMeta(body, {surface, actor, part, layer, mesh})   自前 body を
 *   unregisterBodyMeta(body)                                      Hit 語彙に載せる
 *
 * CONSTANTS
 *   phys.LAYER / phys.MASK / phys.SURFACE / phys.SURFACE_NAMES / phys.SURFACE_PROPS
 */

import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin.js';
import { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody.js';
import {
  PhysicsShapeMesh,
  PhysicsShapeBox,
  PhysicsShapeSphere,
  PhysicsShapeCapsule,
} from '@babylonjs/core/Physics/v2/physicsShape.js';
import { PhysicsMotionType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js';
import { PhysicsRaycastResult } from '@babylonjs/core/Physics/physicsRaycastResult.js';
import { ShapeCastResult } from '@babylonjs/core/Physics/shapeCastResult.js';
import {
  PhysicsCharacterController,
  CharacterSupportedState,
} from '@babylonjs/core/Physics/v2/characterController.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
/**
 * **副作用 import。消さないこと。**
 *
 * Babylon はツリーシェイキング前提の構成で、`scene.enablePhysics()` /
 * `scene.getPhysicsEngine()` は Scene のプロトタイプに **このモジュールが拡張として
 * 生やす**。import しないと `enablePhysics` が存在せず、しかも
 * 「Cannot read properties of undefined (reading 'setTimeStep')」のように
 * 一段先で落ちるため原因が分かりにくい。
 *
 * 「使っていない import」に見えるので、lint やエディタの自動整理で消されやすい。
 */
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent.js';

import { UNITS } from '../core/config.js';
import { loadHavok } from './havok.js';
import {
  LAYER,
  MASK,
  SURFACE,
  SURFACE_NAMES,
  SURFACE_PROPS,
  surfaceIndex,
  surfaceName,
  guessSurface,
} from './surfaces.js';

/** Hit レコードのリングプール深さ。1 フレームで同時に生きうる Hit の上限。 */
const HIT_POOL = 64;
/** bullet:impact のペイロードプール。貫通は 1 発で最大 8 層 = 16 impact。 */
const IMPACT_POOL = 48;

const _v0 = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _q0 = Quaternion.Identity();

function makeHit() {
  return {
    hit: false,
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
    distance: Infinity,
    fraction: 1,
    surface: 'concrete',
    surfaceIndex: SURFACE.concrete,
    /** ヒットした Babylon のメッシュ (あれば)。 */ object: null,
    /** ヒットした PhysicsBody。 */ body: null,
    /** AI エージェント等の所有者 (あれば)。 */ actor: null,
    /** 'head' | 'torso' | ... ヒットボックス部位 (あれば)。 */ part: null,
  };
}

function makeImpact() {
  return {
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
    incident: new Vector3(0, 0, -1),
    surface: 'concrete',
    surfaceIndex: SURFACE.concrete,
    damage: 0,
    /** true なら貫通後の「出口」。fx は出口で別の演出を出す。 */ exit: false,
    object: null,
    body: null,
    actor: null,
    part: null,
  };
}

/**
 * キャラクタコントローラのラッパ。
 *
 * Babylon の PhysicsCharacterController をそのまま公開せず薄く包むのは、
 * Three 版の `CharacterController` と **同じ公開 API** を保つため。player と ai は
 * どちらもこの API に対して書かれており、ここを合わせておけば両サブシステムの
 * 移植が実質「import の差し替え」で済む。
 */
class Character {
  constructor(system, opts) {
    this.system = system;
    this.radius = opts.radius ?? UNITS.playerRadius;
    this.height = opts.height ?? UNITS.playerHeight;
    /** 登れる段差の上限。これを超える段差は壁として扱われる。 */
    this.stepHeight = opts.stepHeight ?? 0.45;
    /** 歩ける最大傾斜 (度)。 */
    this.slopeLimit = opts.slopeLimit ?? 52;

    const pos = opts.position
      ? new Vector3(opts.position.x, opts.position.y, opts.position.z)
      : new Vector3(0, 2, 0);

    this.ctrl = new PhysicsCharacterController(
      pos,
      { capsuleHeight: this.height, capsuleRadius: this.radius },
      system.scene
    );
    this.ctrl.maxSlopeCosine = Math.cos((Math.PI * this.slopeLimit) / 180);
    this.ctrl.maxStepHeight = this.stepHeight;
    /**
     * **`acceleration` は 1 にすること。Babylon の既定 0.05 は罠。**
     *
     * `calculateMovement` は希望速度へ「`acceleration` の割合だけ」近づける補間係数を
     * 持っており、既定は 0.05 = 1 ステップで 5% しか近づかない (Babylon 本体のコメントも
     * "A value of 1 means reaching max velocity immediately" と書いている)。
     *
     * この係数は **呼び出し側が計算した速度を無条件に上書きする**。
     * `player/movement.js` は `MOVE.groundAccel = 92 m/s^2` (50 ms で最高速。CoD の
     * 「タイト」な操作感の正体) で希望速度を作っているのに、CC 側で二重に鈍らされて
     * いた。加速カーブの所有者は 1 つでなければならず、それは movement.js 側。
     *
     * 実測 (W キー押しっぱなし、目標 4.57 m/s、既定値のとき):
     *   57 フレーム (0.95 s) 経っても 2.51 m/s、45 フレームで 0.4 m しか進まない
     *   速度の増分がフレームごとに 0.11 → 0.035 m/s と減っていく (指数漸近の形)
     *
     * 「動いてはいる」ので playtest は通ってしまい、移植中ずっと気付かなかった。
     * `maxAcceleration` (既定 50 m/s^2) は安全弁として残す — groundAccel 92 は
     * 1 ステップぶん (h=1/120) に直せば 0.77 m/s で、この上限には当たらない。
     */
    this.ctrl.acceleration = 1;

    /** 読み取り専用として扱うこと。書き換えたい時は teleport() を使う。 */
    this.position = pos.clone();
    this.velocity = new Vector3();
    this.grounded = false;
    this.groundNormal = new Vector3(0, 1, 0);
    this.groundSurfaceName = 'concrete';
    this.touchingCeiling = false;
    /** 接地した瞬間の落下速度 (m/s, 正値)。着地 FX / 落下ダメージ用。 */
    this.landingSpeed = 0;
    /** 直前の move() が壁で止められたか。 */
    this.lastMoveBlocked = false;

    this._wasGrounded = false;
  }

  /**
   * 希望速度を与えて 1 物理ステップ進める。
   *
   * 引数は「速度」であって「変位」ではない (Three 版と同じ)。呼び出し側は
   * fixedUpdate から毎ステップ呼ぶ。
   */
  move(dx, dy, dz) {
    const dt = this.system.fixedDt;
    const ctrl = this.ctrl;

    // 接地判定は重力方向へのプローブ。checkSupport は step-up や傾斜スライドの
    // 判定まで含めた状態を返す。
    const info = ctrl.checkSupport(dt, this.system.gravityDir);

    const supported = info.supportedState === CharacterSupportedState.SUPPORTED;
    this.groundNormal.copyFrom(info.averageSurfaceNormal);

    // 着地の瞬間だけ landingSpeed を立てる。player はこれを見て着地 FX と
    // 落下ダメージを出す。次の move() で 0 に戻る (エッジ的な値)。
    const vy = ctrl.getVelocity().y;
    this.landingSpeed = !this._wasGrounded && supported ? Math.max(0, -vy) : 0;
    this._wasGrounded = supported;
    this.grounded = supported;

    _v0.set(dx, dy, dz);
    const bx = ctrl.getPosition().x;
    const bz = ctrl.getPosition().z;

    /**
     * 速度の決め方 — **接地時と空中で経路を分ける**。
     *
     * `calculateMovement` は「動く床の速度・現在速度・希望速度」から適用速度を作り、
     * 傾斜を滑り落ちる挙動まで含めてくれる。接地しているときはこれが正しい。
     *
     * だが **空中では使わない**。この関数は面の法線を前提にしており、支持面が無い
     * ときに渡すと落下速度 (y) を潰してしまう。結果としてキャラクタが空中で
     * 静止し、永久に接地しない。呼び出し側 (player/movement.js) が重力を積んで
     * いるので、空中ではその速度をそのまま使うのが正しい。
     */
    if (supported) {
      const desired = ctrl.calculateMovement(
        dt,
        this.system.forwardHint,
        info.averageSurfaceNormal,
        ctrl.getVelocity(),
        info.averageSurfaceVelocity,
        _v0,
        this.system.upDir
      );
      ctrl.setVelocity(desired);
    } else {
      ctrl.setVelocity(_v0);
    }
    ctrl.integrate(dt, info, this.system.gravity);

    const after = ctrl.getPosition();
    this.position.copyFrom(after);
    this.velocity.copyFrom(ctrl.getVelocity());

    // 「押し込んだのにほとんど動いていない」= 壁で止められた。落下中は常に
    // 動いているので、水平成分だけで判定する。
    const wantHoriz = Math.hypot(dx, dz) * dt;
    const gotHoriz = Math.hypot(after.x - bx, after.z - bz);
    this.lastMoveBlocked = wantHoriz > 1e-4 && gotHoriz < wantHoriz * 0.35;

    // 天井接触。しゃがみ解除の可否に使う。
    this.touchingCeiling = !this.canFit(this.height);

    // 立っている面の surface 名。足音・着地音・decal がこれを見る。
    this.groundSurfaceName = supported ? this.system.surfaceUnder(after, this.radius) : 'concrete';

    return this;
  }

  /** カプセル高さを変える (しゃがみ/伏せ)。足位置を保つので沈み込まない。 */
  setHeight(h) {
    if (Math.abs(h - this.height) < 1e-4) return;
    this.height = h;
    this.ctrl.setShapeOptions({ capsuleHeight: h, capsuleRadius: this.radius }, true);
  }

  /** 高さ h のカプセルが今の位置に収まるか。しゃがみ解除の可否判定。 */
  canFit(h) {
    const headroom = h - this.height;
    if (headroom <= 0) return true;
    const p = this.ctrl.getPosition();
    _v0.set(p.x, p.y, p.z);
    _v1.set(0, 1, 0);
    return !this.system.raycast(_v0, _v1, headroom + this.height * 0.5, MASK.CHARACTER).hit;
  }

  teleport(x, y, z) {
    _v0.set(x, y, z);
    this.ctrl.setPosition(_v0);
    this.ctrl.setVelocity(Vector3.ZeroReadOnly);
    this.position.copyFrom(_v0);
    this.velocity.setAll(0);
    this._wasGrounded = false;
    return this;
  }

  dispose() {
    this.ctrl.dispose();
  }
}

/** 剛体のラッパ。Three 版の RigidBody と同じ公開 API を保つ。 */
class RigidBody {
  constructor(system, body, node, opts) {
    this.system = system;
    this.body = body;
    this.node = node;
    this.surface = opts.surface ?? 'metal';
    /** 秒。0 以下なら寿命なし。 */
    this.lifetime = opts.lifetime ?? 0;
    this.age = 0;
  }

  get position() {
    return this.node.position;
  }

  applyImpulse(ix, iy, iz, px, py, pz) {
    _v0.set(ix, iy, iz);
    _v1.set(px ?? this.node.position.x, py ?? this.node.position.y, pz ?? this.node.position.z);
    this.body.applyImpulse(_v0, _v1);
  }

  get sleeping() {
    // Havok はスリープ状態を直接公開しないので速度で近似する。デブリの更新を
    // 省いてよいかの判定にしか使わないため、この精度で十分。
    return this.body.getLinearVelocity().lengthSquared() < 1e-4;
  }
}

export class PhysicsSystem {
  static id = 'physics';
  static deps = [];

  constructor() {
    /** 定数を公開 — 他サブシステムは phys.MASK などで参照する。 */
    this.LAYER = LAYER;
    this.MASK = MASK;
    this.SURFACE = SURFACE;
    this.SURFACE_NAMES = SURFACE_NAMES;
    this.SURFACE_PROPS = SURFACE_PROPS;

    this.characters = [];
    this.rigidBodies = [];

    this._hitPool = Array.from({ length: HIT_POOL }, makeHit);
    this._hitCursor = 0;
    this._impactPool = Array.from({ length: IMPACT_POOL }, makeImpact);
    this._impactCursor = 0;
    this._impactResult = [];

    /** PhysicsBody -> { surface, surfaceIndex, layer, mesh, actor, part } */
    this._meta = new Map();

    this._ray = new PhysicsRaycastResult();
    this._shapeStart = new ShapeCastResult();
    this._shapeHit = new ShapeCastResult();
    this._sphereCache = new Map();
    this._capsuleCache = new Map();

    this.upDir = new Vector3(0, 1, 0);
    this.gravityDir = new Vector3(0, -1, 0);
    /**
     * calculateMovement に渡す「前方ヒント」。傾斜での速度合成にしか使われず、
     * 実際の移動方向は desiredVelocity が決めるので固定値でよい。
     */
    this.forwardHint = new Vector3(0, 0, -1);
  }

  async init(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.rng = ctx.rng.fork();
    this.fixedDt = ctx.time.fixed;

    const havok = await loadHavok();
    // useDeltaForWorldStep = false。実フレーム時間ではなく、こちらが渡す固定
    // ステップで進めさせる。決定性の要。
    this.plugin = new HavokPlugin(false, havok);

    this.gravity = new Vector3(0, UNITS.gravity, 0);
    ctx.scene.enablePhysics(this.gravity, this.plugin);
    this.engine = ctx.scene.getPhysicsEngine();

    /**
     * **自動ステップを止める。**
     *
     * Babylon は既定で scene.render() の中から実フレーム時間で物理を進める。
     * それではフレームレートが変わるだけで結果が変わり、キャプチャの
     * bit-identical が成立しない。0 を渡すと自動ステップが無効になるので、
     * 以降は fixedUpdate から明示的に _step() を呼ぶ。
     */
    this.engine.setTimeStep(0);

    ctx.events.on('explosion', (e) => this.explode(e));
  }

  /* ================================================================== */
  /* Static world                                                       */
  /* ================================================================== */

  /**
   * 静的なレベルジオメトリを登録する。world サブシステムが必ず呼ぶこと。
   *
   * `surfaceType` を省略するとメッシュ名から推測する (guessSurface)。推測に頼ると
   * 「なぜか木の壁がコンクリート音になる」類の事故が起きるので、world 側は明示的に
   * 渡すのが望ましい。
   */
  addStatic(mesh, surfaceType, opts = {}) {
    if (!mesh || !mesh.getTotalVertices?.()) return null;

    const si = surfaceType === undefined ? guessSurface(mesh.name) : surfaceIndex(surfaceType);
    const layer = opts.layer ?? LAYER.STATIC;

    const shape = new PhysicsShapeMesh(mesh, this.scene);
    shape.filterMembershipMask = layer;
    shape.filterCollideMask = MASK.ALL;

    const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, this.scene);
    body.shape = shape;

    this._meta.set(body, {
      surfaceIndex: si,
      surface: surfaceName(si),
      layer,
      mesh,
      actor: opts.actor ?? null,
      part: opts.part ?? null,
    });

    return body;
  }

  /** メッシュツリーを丸ごと登録する。ジオメトリを持つ子孫だけが対象。 */
  addStaticGroup(root, surfaceType, opts = {}) {
    const out = [];
    const visit = (node) => {
      if (node.getTotalVertices?.() > 0 && !node.metadata?.owNoCollision) {
        const h = this.addStatic(node, surfaceType, opts);
        if (h) out.push(h);
      }
      for (const c of node.getChildren?.() ?? []) visit(c);
    };
    visit(root);
    return out;
  }

  removeStatic(handle) {
    if (!handle) return;
    this._meta.delete(handle);
    handle.dispose();
  }

  /**
   * 外部サブシステムが自前で作った PhysicsBody をメタデータ表に載せる公開 API。
   *
   * Hit / bullet:impact に surface / actor / part を載せるのはこの表で、載って
   * いない body は `surface:'concrete' / actor:null` になる (CC 内部 body で実際に
   * 踏んだ罠 — createCharacter のコメント参照)。ai のヒットボックスやラグドールの
   * ように body のライフサイクルを自分で管理する呼び出し側はこれを使うこと。
   * `_meta` に直接 set しない (private を触る箇所を増やさない)。
   *
   * NOTE: `actor` を null にすると弾が当たっても damage:dealt が発行されない。
   * 死体 (ラグドール) は意図的に actor:null で登録する — ヒットマーカーや
   * キルフィードが死体撃ちで再発火しないようにするため。
   */
  registerBodyMeta(body, opts = {}) {
    if (!body) return;
    const si = surfaceIndex(opts.surface ?? 'concrete');
    this._meta.set(body, {
      surfaceIndex: si,
      surface: surfaceName(si),
      layer: opts.layer ?? LAYER.DEBRIS,
      mesh: opts.mesh ?? null,
      actor: opts.actor ?? null,
      part: opts.part ?? null,
    });
  }

  /** registerBodyMeta の対。body を消す側が必ず呼ぶこと (Map リーク防止)。 */
  unregisterBodyMeta(body) {
    if (body) this._meta.delete(body);
  }

  /**
   * Havok は静的ボディの追加/削除を増分で処理するため、Three 版のような明示的な
   * BVH 再構築は不要。API 互換のために残してある no-op。
   */
  rebuildStatic() {}

  /* ================================================================== */
  /* Queries                                                            */
  /* ================================================================== */

  _nextHit() {
    const h = this._hitPool[this._hitCursor];
    this._hitCursor = (this._hitCursor + 1) % HIT_POOL;
    h.hit = false;
    h.distance = Infinity;
    h.fraction = 1;
    h.object = null;
    h.body = null;
    h.actor = null;
    h.part = null;
    h.surfaceIndex = SURFACE.concrete;
    h.surface = 'concrete';
    return h;
  }

  _applyMeta(h, body) {
    h.body = body ?? null;
    const m = body ? this._meta.get(body) : null;
    if (m) {
      h.surfaceIndex = m.surfaceIndex;
      h.surface = m.surface;
      h.object = m.mesh;
      h.actor = m.actor;
      h.part = m.part;
    } else {
      h.object = body?.transformNode ?? null;
    }
  }

  /**
   * レイキャスト。`dir` は正規化されていなくてよい。
   * 戻り値は常にオブジェクト (リングプール由来) なので `.hit` を確認すること。
   */
  raycast(origin, dir, maxDist = 1000, mask = MASK.WORLD) {
    const h = this._nextHit();
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    _v0.set(origin.x, origin.y, origin.z);
    _v1.set(
      origin.x + (dir.x / len) * maxDist,
      origin.y + (dir.y / len) * maxDist,
      origin.z + (dir.z / len) * maxDist
    );

    this._ray.reset(_v0, _v1);
    this.plugin.raycast(_v0, _v1, this._ray, { collideWith: mask });
    if (!this._ray.hasHit) return h;

    h.hit = true;
    h.point.copyFrom(this._ray.hitPointWorld);
    h.normal.copyFrom(this._ray.hitNormalWorld);
    h.distance = this._ray.hitDistance;
    h.fraction = maxDist > 0 ? h.distance / maxDist : 0;
    this._applyMeta(h, this._ray.body);
    return h;
  }

  raycastAny(origin, dir, maxDist = 1000, mask = MASK.SIGHT) {
    return this.raycast(origin, dir, maxDist, mask).hit;
  }

  /** from から to が見通せるか。glass / foliage は既定で視線を遮らない。 */
  lineOfSight(from, to, mask = MASK.SIGHT) {
    _v2.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const d = _v2.length();
    if (d < 1e-5) return true;
    return !this.raycast(from, _v2, d, mask).hit;
  }

  /** 球を掃引する。maxDist まで進めて最初の接触を返す。 */
  sphereCast(origin, dir, radius, maxDist = 100, mask = MASK.WORLD) {
    return this._shapeCast(this._scratchSphere(radius), origin, dir, maxDist, mask);
  }

  /**
   * カプセルを掃引する。p0/p1 はカプセルの両端 (world 空間)。
   * キャラクタの移動先チェックや AI のカバー移動可否に使う。
   */
  capsuleCast(p0, p1, radius, dir, maxDist = 100, mask = MASK.CHARACTER) {
    const h = Vector3.Distance(p0, p1);
    _v2.set((p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5, (p0.z + p1.z) * 0.5);
    return this._shapeCast(this._scratchCapsule(radius, h), _v2, dir, maxDist, mask);
  }

  _shapeCast(shape, origin, dir, maxDist, mask) {
    const hit = this._nextHit();
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    _v0.set(origin.x, origin.y, origin.z);
    _v1.set(
      origin.x + (dir.x / len) * maxDist,
      origin.y + (dir.y / len) * maxDist,
      origin.z + (dir.z / len) * maxDist
    );
    shape.filterCollideMask = mask;

    this._shapeStart.reset();
    this._shapeHit.reset();
    this.plugin.shapeCast(
      { shape, rotation: _q0, startPosition: _v0, endPosition: _v1, shouldHitTriggers: false },
      this._shapeStart,
      this._shapeHit
    );

    if (!this._shapeHit.hasHit) return hit;
    hit.hit = true;
    hit.point.copyFrom(this._shapeHit.hitPoint);
    hit.normal.copyFrom(this._shapeHit.hitNormal);
    hit.fraction = this._shapeHit.hitFraction;
    hit.distance = hit.fraction * maxDist;
    this._applyMeta(hit, this._shapeHit.body);
    return hit;
  }

  /** 球の重なり数。0 なら空いている。 */
  overlapSphere(center, radius, mask = MASK.CHARACTER) {
    // Havok に直接の overlap クエリが無いので、ほぼゼロ長の shapeCast で代用する。
    _v0.set(0, 1, 0);
    return this._shapeCast(this._scratchSphere(radius), center, _v0, 1e-4, mask).hit ? 1 : 0;
  }

  /** カプセルが空いているか。true = 何にも当たらない。 */
  checkCapsule(p0, p1, radius, mask = MASK.CHARACTER) {
    _v0.set(0, 1, 0);
    return !this.capsuleCast(p0, p1, radius, _v0, 1e-4, mask).hit;
  }

  /** (x, z) の真下の床の高さ。何も無ければ -Infinity。 */
  groundHeight(x, z, fromY = 200, mask = MASK.WORLD) {
    _v0.set(x, fromY, z);
    _v1.set(0, -1, 0);
    const h = this.raycast(_v0, _v1, fromY + 400, mask);
    return h.hit ? h.point.y : -Infinity;
  }

  /** 足元の surface 名。足音・着地音・decal の選択に使う。 */
  surfaceUnder(pos, radius = 0.3) {
    _v0.set(pos.x, pos.y, pos.z);
    _v1.set(0, -1, 0);
    const h = this.raycast(_v0, _v1, radius + 1.4, MASK.WORLD);
    return h.hit ? h.surface : 'concrete';
  }

  /**
   * クエリ用の形状はキャッシュする。**毎フレーム new すると Havok 側に形状が
   * 溜まり続けてリークする** (ARCHITECTURE.md Hard rule 5 の精神)。
   */
  _scratchSphere(r) {
    const key = Math.round(r * 1000);
    let s = this._sphereCache.get(key);
    if (!s) {
      s = new PhysicsShapeSphere(Vector3.Zero(), r, this.scene);
      this._sphereCache.set(key, s);
    }
    return s;
  }

  _scratchCapsule(r, h) {
    const key = `${Math.round(r * 1000)}:${Math.round(h * 1000)}`;
    let s = this._capsuleCache.get(key);
    if (!s) {
      const half = Math.max(0.001, h * 0.5);
      s = new PhysicsShapeCapsule(new Vector3(0, -half, 0), new Vector3(0, half, 0), r, this.scene);
      this._capsuleCache.set(key, s);
    }
    return s;
  }

  /* ================================================================== */
  /* Characters                                                         */
  /* ================================================================== */

  /**
   * キャラクタコントローラを作る。
   *
   * ## `actor` / `surface` を必ず渡すこと (弾が当たる主体の場合)
   *
   * `PhysicsCharacterController` は **内部で PhysicsBody を作り、フィルタは全ビット
   * 立った状態**になっている。つまり弾のレイに当たる。しかしその body は physics の
   * メタデータ表に載っていないため:
   *
   *   - `hit.surface` が既定の 'concrete' になる (足元が肉でもコンクリ音・コンクリ片)
   *   - `hit.actor` が null なので **damage:dealt が発行されず、ダメージが入らない**
   *
   * 実測 (修正前): 8m 手前からプレイヤーへ撃つと 7.75m で
   * `{surface:'concrete', hasActor:false}` に当たっていた。**敵の弾が当たっても
   * プレイヤーは一切ダメージを受けない**状態だった。
   *
   * ここで body をメタデータ表に登録することで、弾が当たれば正しく actor 付きの
   * Hit になり damage:dealt が流れる。
   *
   * 逆に「弾に当たってほしくない」CC (別途ヒットボックスを持つ ai など) は
   * `opts.bulletProof = true` を渡す。フィルタを CLIP に落として弾と視線から外す。
   */
  createCharacter(opts = {}) {
    const c = new Character(this, {
      radius: UNITS.playerRadius,
      height: UNITS.playerHeight,
      ...opts,
    });
    this.characters.push(c);

    /**
     * CC の内部 body は private (`ctrl._body`)。**public な取得手段が無い**ので
     * 直接触っている。Babylon を上げたときに名前が変わっていないか確認すること。
     * 名前が変われば静かに登録されなくなり、「弾が当たるのにダメージが入らない」
     * 状態に戻る (エラーは出ない)。
     */
    const body = c.ctrl?._body;
    if (body) {
      c.body = body;
      if (opts.bulletProof) {
        // 弾と視線から外す。別途ヒットボックスを持つキャラクタ向け。
        const shape = c.ctrl._shape;
        if (shape) {
          shape.filterMembershipMask = LAYER.CLIP;
          shape.filterCollideMask = MASK.CHARACTER;
        }
      } else {
        const si = surfaceIndex(opts.surface ?? 'flesh');
        this._meta.set(body, {
          surfaceIndex: si,
          surface: surfaceName(si),
          layer: LAYER.ACTOR,
          mesh: null,
          actor: opts.actor ?? null,
          part: opts.part ?? 'torso',
        });
        /**
         * 掃引対象から RAGDOLL 層だけを外す。
         *
         * Havok のフィルタは対称 ((A.mem & B.col) && (B.mem & A.col)) なので、
         * こちら側の collide から RAGDOLL ビットを落とすだけで「プレイヤーの CC が
         * 死体を蹴飛ばす / 死体に足止めされる」の両方向が消える (ラグドール側の
         * membership は LAYER.RAGDOLL のみ — ai/ragdoll.js 参照)。
         *
         * membership は全ビットのまま残す — ここを絞ると敵弾のレイ (MASK.BULLET)
         * や AI の視線がプレイヤーに当たらなくなる方向の事故になるため、変更は
         * collide 側だけに留める。
         */
        const shape = c.ctrl._shape;
        if (shape) shape.filterCollideMask = MASK.ALL & ~LAYER.RAGDOLL;
      }
    }
    return c;
  }

  removeCharacter(c) {
    const i = this.characters.indexOf(c);
    if (i >= 0) this.characters.splice(i, 1);
    if (c.body) this._meta.delete(c.body);
    c.dispose?.();
  }

  /* ================================================================== */
  /* Ballistics                                                         */
  /* ================================================================== */

  /**
   * 弾を 1 発ワールドに撃ち込み、貫通できるものを貫通させる。
   *
   * 入口と出口の両方で `bullet:impact` を emit するのが仕様 (ARCHITECTURE.md)。
   * fx はこれを見て、入口には着弾 FX と decal、出口には裏抜けの土煙を出す。
   *
   * 貫通モデル: 各層で SURFACE_PROPS の penDepth と energyLoss を引き、残弾威力を
   * 減衰させる。威力が尽きるか層数上限に達したら停止。偏向 (deflect) は必ず `rng`
   * 経由 — Math.random() を使うとキャプチャが揺れる。
   */
  fireBullet(opts) {
    const origin = opts.origin;
    const dir = opts.dir;
    const maxDist = opts.maxDist ?? 300;
    const mask = opts.mask ?? MASK.BULLET;
    const rng = opts.rng ?? this.rng;
    /**
     * true なら actor に当たっても damage:dealt を発行しない (bullet:impact は
     * 出すので着弾 FX / デカールは通常どおり)。キャプチャ用 staged 敵の射撃
     * (ai の staged.noDamage) が使う — これが無いと staged の実弾がプレイヤーの
     * CC に当たって体力を削り、キャプチャが被弾フィルタ越しの絵になる (実測:
     * combat ショットで HP 0 の赤ビネット)。
     */
    const noDamage = opts.noDamage ?? false;
    /** 貫通力。1.0 = 参照弾 (7.62x51 相当)。 */
    let power = opts.penetration ?? 1;
    let damage = opts.damage ?? 30;

    const res = this._impactResult;
    res.length = 0;

    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    let px = origin.x;
    let py = origin.y;
    let pz = origin.z;
    let dx = dir.x / len;
    let dy = dir.y / len;
    let dz = dir.z / len;
    let remaining = maxDist;

    // 層数の上限。壁 → 家具 → 壁 のような多層を許しつつ無限ループを防ぐ。
    const MAX_LAYERS = 8;

    for (let layer = 0; layer < MAX_LAYERS && remaining > 0.01; layer++) {
      _v0.set(px, py, pz);
      _v1.set(dx, dy, dz);
      const hit = this.raycast(_v0, _v1, remaining, mask);
      if (!hit.hit) break;

      const props = SURFACE_PROPS[hit.surfaceIndex] ?? SURFACE_PROPS[SURFACE.concrete];

      // 入口 impact。
      this.emitImpact(
        hit.point.x, hit.point.y, hit.point.z,
        hit.normal.x, hit.normal.y, hit.normal.z,
        dx, dy, dz,
        hit.surfaceIndex, damage, false, hit, noDamage
      );
      res.push(this._impactPool[(this._impactCursor - 1 + IMPACT_POOL) % IMPACT_POOL]);

      const advanced = hit.distance + 0.001;

      // この層を貫通できるか。penDepth を超える厚みは抜けない。
      const maxPen = props.penDepth * power;
      if (maxPen <= 0.001) break;

      // 出口を探す: 進行方向へ maxPen 進んだ先から逆向きにレイを撃ち裏面を拾う。
      // 厚みが maxPen を超えるならヒットせず = 貫通失敗。
      const probe = Math.min(maxPen, Math.max(0, remaining - advanced));
      if (probe <= 0.001) break;
      const entry = hit.point;
      _v0.set(
        entry.x + dx * (probe + 0.002),
        entry.y + dy * (probe + 0.002),
        entry.z + dz * (probe + 0.002)
      );
      _v1.set(-dx, -dy, -dz);
      const back = this.raycast(_v0, _v1, probe + 0.004, mask);
      if (!back.hit) {
        // 抜けられなかった。ここで停止。
        break;
      }

      const thickness = Math.max(0.001, probe + 0.002 - back.distance);
      const consumed = thickness / props.penDepth;
      damage *= Math.max(0, 1 - props.energyLoss * consumed);
      power -= consumed;

      // 出口 impact。
      this.emitImpact(
        back.point.x, back.point.y, back.point.z,
        back.normal.x, back.normal.y, back.normal.z,
        dx, dy, dz,
        hit.surfaceIndex, damage, true, hit, noDamage
      );
      res.push(this._impactPool[(this._impactCursor - 1 + IMPACT_POOL) % IMPACT_POOL]);

      if (power <= 0 || damage < 1) break;

      // 偏向。決定的でなければならないので必ず rng 経由。
      const scatter = props.deflect * consumed;
      if (scatter > 0) {
        dx += rng.signed() * scatter;
        dy += rng.signed() * scatter;
        dz += rng.signed() * scatter;
        const l2 = Math.hypot(dx, dy, dz) || 1;
        dx /= l2;
        dy /= l2;
        dz /= l2;
      }

      px = back.point.x + dx * 0.002;
      py = back.point.y + dy * 0.002;
      pz = back.point.z + dz * 0.002;
      remaining -= advanced + thickness;
    }

    return res;
  }

  emitImpact(px, py, pz, nx, ny, nz, dx, dy, dz, si, damage, exit, hit, noDamage = false) {
    const p = this._impactPool[this._impactCursor];
    this._impactCursor = (this._impactCursor + 1) % IMPACT_POOL;
    p.point.set(px, py, pz);
    p.normal.set(nx, ny, nz);
    p.incident.set(dx, dy, dz);
    p.surfaceIndex = si;
    p.surface = surfaceName(si);
    p.damage = damage;
    p.exit = exit;
    p.object = hit?.object ?? null;
    p.body = hit?.body ?? null;
    p.actor = hit?.actor ?? null;
    p.part = hit?.part ?? null;
    this.ctx.events.emit('bullet:impact', p);

    // ダメージは「入口」でのみ与える。出口でも与えると 1 発で 2 回当たる。
    // noDamage (staged 射撃) は FX だけ出してダメージ経路を全部黙らせる。
    if (p.actor && !exit && !noDamage) {
      this.ctx.events.emit('damage:dealt', {
        target: p.actor,
        amount: damage,
        headshot: hit?.part === 'head',
        killed: false,
        point: p.point,
      });
    }
  }

  /** 爆発。剛体を吹き飛ばす。壁で遮蔽されるので壁の裏の箱は飛ばない。 */
  explode(e) {
    if (!e) return;
    const pos = e.position ?? e;
    const radius = e.radius ?? 5;
    const strength = e.impulse ?? (e.damage ?? 100) * 0.9;

    for (const rb of this.rigidBodies) {
      const p = rb.node.position;
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      const dz = p.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius || d < 1e-4) continue;
      if (!this.lineOfSight(pos, p, MASK.EXPLOSION)) continue;

      const falloff = 1 - d / radius;
      const s = (strength * falloff * falloff) / d;
      rb.applyImpulse(dx * s, dy * s + strength * falloff * 0.25, dz * s, p.x, p.y, p.z);
    }
  }

  /* ================================================================== */
  /* Rigid bodies                                                       */
  /* ================================================================== */

  /**
   * 剛体を追加する。`mesh` を渡せばそれが物理に追従する。渡さない場合は不可視の
   * TransformNode が作られ、呼び出し側が position を読んで描画する。
   */
  addRigidBody(opts = {}) {
    const node = opts.mesh ?? new TransformNode('rb', this.scene);
    if (opts.position) node.position.copyFrom(opts.position);
    node.rotationQuaternion ??= Quaternion.Identity();
    /**
     * **ワールド行列を明示的に確定させてから PhysicsBody を作る。**
     *
     * PhysicsBody のコンストラクタは `transformNode.absolutePosition` を読むが、
     * 親なしの新規ノードでは world matrix を強制計算しない (親付きのみ計算する
     * 分岐がある)。作りたてのノードの absolutePosition はゼロのままなので、
     * これが無いと **body が (0,0,0) に生成される** (実測: 指定位置 y=3 のはず
     * のカプセルが Havok 内で原点に居た)。
     */
    node.computeWorldMatrix(true);

    let shape;
    const kind = opts.shape ?? 'box';
    if (kind === 'sphere') {
      shape = new PhysicsShapeSphere(Vector3.Zero(), opts.radius ?? 0.1, this.scene);
    } else if (kind === 'capsule') {
      const half = (opts.height ?? 0.3) * 0.5;
      shape = new PhysicsShapeCapsule(
        new Vector3(0, -half, 0),
        new Vector3(0, half, 0),
        opts.radius ?? 0.08,
        this.scene
      );
    } else {
      const he = opts.halfExtents ?? { x: 0.06, y: 0.06, z: 0.06 };
      shape = new PhysicsShapeBox(
        Vector3.Zero(),
        Quaternion.Identity(),
        new Vector3(he.x * 2, he.y * 2, he.z * 2),
        this.scene
      );
    }
    shape.filterMembershipMask = opts.layer ?? LAYER.DEBRIS;
    shape.filterCollideMask = opts.mask ?? MASK.DEBRIS;

    const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, this.scene);
    body.shape = shape;
    body.setMassProperties({ mass: opts.mass ?? 1 });
    if (opts.velocity) {
      _v0.set(opts.velocity.x, opts.velocity.y, opts.velocity.z);
      body.setLinearVelocity(_v0);
    }
    if (opts.angularVelocity) {
      _v0.set(opts.angularVelocity.x, opts.angularVelocity.y, opts.angularVelocity.z);
      body.setAngularVelocity(_v0);
    }

    const si = surfaceIndex(opts.surface ?? 'metal');
    this._meta.set(body, {
      surfaceIndex: si,
      surface: surfaceName(si),
      layer: opts.layer ?? LAYER.DEBRIS,
      mesh: opts.mesh ?? null,
      actor: opts.actor ?? null,
      part: null,
    });

    const rb = new RigidBody(this, body, node, opts);
    this.rigidBodies.push(rb);
    return rb;
  }

  removeRigidBody(b) {
    const i = this.rigidBodies.indexOf(b);
    if (i >= 0) this.rigidBodies.splice(i, 1);
    this._meta.delete(b.body);
    b.body.dispose();
    if (!b.node.metadata?.owKeep) b.node.dispose();
  }

  /** 破片を 1 つ飛ばす。着弾 FX から呼ばれる。 */
  spawnDebris(position, velocity, opts = {}) {
    const s = opts.size ?? 0.05;
    return this.addRigidBody({
      shape: 'box',
      halfExtents: { x: s, y: s, z: s },
      mass: opts.mass ?? 0.15,
      position,
      velocity,
      surface: opts.surface ?? 'concrete',
      lifetime: opts.lifetime ?? 6,
      mesh: opts.mesh ?? null,
      layer: LAYER.DEBRIS,
      mask: MASK.DEBRIS,
    });
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  fixedUpdate(h) {
    /**
     * Havok を固定ステップで 1 回進める。engine が MAX_SUBSTEPS で回数を制限
     * しているので、ここでは 1 ステップだけ進めればよい。
     *
     * ## setTimeStep をステップの前後で切り替える理由 (実測で踏んだ罠)
     *
     * `HavokPlugin(useDeltaForWorldStep=false)` は **executeStep の引数 delta を
     * 捨てて `_fixedTimeStep` を使う** (havokPlugin.js L590)。init() の
     * `setTimeStep(0)` は自動ステップ (scene.render 内) を殺すが、その状態で
     * `engine._step(h)` を呼んでも HP_World_Step(world, **0**) になり、
     * **動力学が一切積分されない**。実測: DYNAMIC ボディが初速を保持したまま
     * 永遠に静止し (速度は残るが位置が動かない)、デブリ・グレネード・
     * ラグドールが全く落ちなかった。CC は自前積分なので気づけない。
     *
     * ここで h を設定 → 1 ステップ → 0 に戻す。戻し忘れると自動ステップが
     * 実フレーム時間で走り出し、決定性 (bit-identical キャプチャ) が壊れる。
     */
    this.engine.setTimeStep(h);
    this.engine._step(h);
    this.engine.setTimeStep(0);

    // 寿命切れのデブリを回収する。splice 中のインデックスずれを避けるため逆順。
    for (let i = this.rigidBodies.length - 1; i >= 0; i--) {
      const rb = this.rigidBodies[i];
      if (rb.lifetime <= 0) continue;
      rb.age += h;
      if (rb.age >= rb.lifetime) this.removeRigidBody(rb);
    }
  }

  dispose() {
    for (const c of this.characters) c.dispose?.();
    this.characters.length = 0;
    for (const rb of [...this.rigidBodies]) this.removeRigidBody(rb);
    this._meta.clear();
    this.scene?.disablePhysicsEngine?.();
  }
}

export { LAYER, MASK, SURFACE, SURFACE_NAMES, SURFACE_PROPS, surfaceName, surfaceIndex };
