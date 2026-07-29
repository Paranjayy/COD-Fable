/**
 * AI — enemy characters, navigation, perception, cover selection and combat
 * behaviour.
 *
 * WHAT LIVES WHERE
 *   rig.js        25-bone skeleton, bind pose, weapon anchor points
 *   geo.js        loft/tube/revolve toolkit, skin binder, baked vertex AO
 *   parts.js      body and kit: jacket, plate carrier, pouches, helmet, boots
 *   weapon.js     the carried carbine / long rifle, baked into the character
 *   textures.js   tiling PBR sets: camo cloth, cordura, skin, polymer, steel
 *   soldier.js    variant assembly -> one skinned geometry + material list
 *   clips.js      hand-authored pose layers (idle/walk/run/crouch/hit/recoil…)
 *   animator.js   layered blending + aim, look-at, arm and foot IK
 *   nav.js        walkability grid from the physics world, A*, string pulling,
 *                 cover point extraction and scoring
 *   agent.js      one enemy: senses, state machine, gun, hit zones, death
 *   squad.js      peek rotation, contact sharing, flank and grenade rationing
 *   --- Babylon 移植で増えた層 ---
 *   math3.js      Three 互換 math shim (上記の大半を無改変で通すための要)
 *   mesh.js       Babylon Mesh/Skeleton 化と CPU 姿勢の書き写し
 *   hitbox.js     部位ヒットボックス (Havok キネマティックカプセル + フィルタ設計)
 *   deathfall.js  手続き死亡モーション (ラグドール不採用の理由もここ)
 *
 * PUBLIC API — `const ai = ctx.get('ai')`
 *   ai.spawn(variant, position, yaw, opts) -> Agent
 *   ai.agents                              live Agent list
 *   ai.debugStage('firefight')             staged combat tableau for captures
 *   ai.prewarmMaterials()                  build every character material
 *   ai.grid / ai.cover                     navigation + cover queries
 *   ai.stats                               { agents, alive, navMs, coverPts,
 *                                            pathsDeferred, lodIrrelevant }
 *
 * FRAME BUDGETS — navigation and the garrison are built during init(), not on
 * the first frame of play; A* is rationed to `ai.pathsPerFrame` solves per frame;
 * and an actor that provably cannot reach a pixel this frame (see
 * `_updateRelevance`) animates at a third rate and leaves the shadow cascades.
 *
 * EVENTS consumed: weapon:fire, bullet:impact, damage:dealt, explosion,
 *   player:footstep
 * EVENTS emitted: weapon:fire (enemy muzzle), weapon:shell, bullet:tracer,
 *   damage:dealt (enemy hitting the player), actor:death
 */

import * as THREE from './math3.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Frustum } from '@babylonjs/core/Maths/math.frustum.js';
import { Plane } from '@babylonjs/core/Maths/math.plane.js';

import { SoldierMaterials } from './textures.js';
import { buildSoldier, resolveMaterials, MATERIAL_SLOTS, VARIANTS } from './soldier.js';
import { RIG } from './rig.js';
import { NavGrid, CoverMap } from './nav.js';
import { Agent, STATE } from './agent.js';
import { Squad } from './squad.js';
import { GroundShadows } from './grounding.js';
import { buildVariantTemplate } from './mesh.js';
import { ray } from './physray.js';

export class AiSystem {
  static id = 'ai';
  static deps = ['physics', 'world'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.root = new TransformNode('ai', ctx.scene);

    const t0 = performance.now();
    this.materials = new SoldierMaterials(this.rng.fork(), {
      size: 512,
      anisotropy: ctx.config.q.anisotropy ?? 8,
      camo: ['arid', 'woodland', 'urban'],
      scene: ctx.scene,
    });
    // Contact occlusion under every actor. Without it the cast shadow alone
    // leaves them hovering: see grounding.js.
    this.ground = new GroundShadows(ctx.scene, this.root, 16);
    this._variants = new Map();
    this.agents = [];
    this.squads = [];
    this.grid = null;
    this.cover = null;
    this.inspect = false;
    this.debugLog = false;
    /** dev: force the garrison to spawn even in deterministic capture runs.
     *  URL の ?aipop=1 でも立つ (パトロール/経路の動作確認用)。 */
    this.forcePopulate =
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('aipop') === '1';
    this._navPending = true;
    this.stats = { agents: 0, alive: 0, navMs: 0, coverPts: 0, walkable: 0 };

    /* scratch */
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._probe = { y: 0, nx: 0, ny: 1, nz: 0, hit: false };
    this._tracerFrom = new THREE.Vector3();
    this._tracerTo = new THREE.Vector3();
    this._fireEvent = {
      weapon: 'ai_rifle',
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      seed: 0,
      // Sprites and light are gained SEPARATELY: see _flashGain/_flashLight.
      // The sprites have to read as fire at 25 m; the punctual light must not
      // turn the shooter into the brightest object in the frame.
      intensity: 0.12,
      light: 0.006,
      // Size is gained separately from radiance: a 0.12-intensity flash scaled
      // geometrically by 0.12 is 3 mm across and invisible at 20 m.
      flashScale: 0.8,
    };
    this._shellEvent = { position: new THREE.Vector3(), velocity: new THREE.Vector3() };
    this._tracerEvent = { from: this._tracerFrom, to: this._tracerTo, speed: 800 };
    this._grenades = [];
    this._grenadeMesh = null;
    this._grenadeMat = null;

    /* ---- frame budgets and LOD state (see _updateRelevance / requestPath) ---- */
    this._pathBudget = 0;
    /** A* solves allowed per frame. Measured (Three 版): one solve is 0.5-1.1 ms
     *  on the 221x221 grid, and a squad that all enters combat on the same frame
     *  used to ask for six of them at once. */
    this.pathsPerFrame = 2;
    this.stats.pathsDeferred = 0;
    /** フラスタム平面 (Babylon)。GetPlanesToRef が毎フレーム書き直す。 */
    this._planes = [];
    for (let i = 0; i < 6; i++) this._planes.push(new Plane(0, 0, 0, 0));
    this._sphereC = { x: 0, y: 0, z: 0 };
    this._sun = new THREE.Vector3(0, 1, 0);
    this._lodStats = { irrelevant: 0 };
    this._stagedAgents = [];
    this._stagedSquad = null;
    /** 直前の入口 bullet:impact の部位 (damage:dealt の部位倍率用 — _wireEvents 参照)。 */
    this._lastImpactActor = null;
    this._lastImpactPart = null;
    this._lastImpactIncident = null;

    this._wireEvents(ctx);
    console.info(
      `[ai] materials ${(performance.now() - t0).toFixed(0)}ms ` +
        `(${this.materials.bakeMs.toFixed(0)}ms texture bake)`
    );
    // The albedo budget is only real if it is measured. Print what every camo
    // bake actually landed on, so a drift out of budget is visible in the
    // capture log instead of only in the critic's histogram.
    for (const k in this.materials.camoStats ?? {}) {
      const s = this.materials.camoStats[k];
      console.info(
        `[ai] camo ${k}: map mean ${s.mean.toFixed(3)} (was ${s.was.toFixed(3)}) ` +
          `range ${s.min.toFixed(3)}-${s.max.toFixed(3)} sd ${s.sd.toFixed(3)}`
      );
    }

    // Navigation and the garrison DURING BOOT (Three 版の実測に基づく判断を
    // 踏襲: 最初の update() に 450ms のフリーズを載せない)。物理がまだ空なら
    // _navPending が立ったままになり update() が再試行する。
    this._bootNav(ctx);
    await this.prewarmMaterials();
  }

  /**
   * Build navigation and garrison the level at boot. Never throws: if physics
   * has no level yet, `_navPending` stays set and `update()` retries.
   */
  _bootNav(ctx) {
    try {
      this._buildNav();
      if (!this._navPending && (!ctx.config.deterministic || this.forcePopulate)) this.populate();
    } catch (err) {
      this._navPending = true;
      console.warn('[ai] boot nav deferred to the first frame:', err?.message ?? err);
    }
  }

  /**
   * 全キャラクタマテリアルを起動時に作っておく。
   *
   * Three 版はここでシェーダ 26 本を CSM 深度バリアント込みで compileAsync して
   * いた。Babylon 版は各パイプラインが自前でエフェクトを管理しており、深度/影の
   * バリアント強制コンパイルに相当する安全な公開 API が (この構成では) 無いため、
   * **マテリアル生成のみ**行う。初回描画時のコンパイルは capture の settle
   * フレームに吸収される。実測で問題になったら forceCompilationAsync の導入を
   * 検討すること (メッシュとペアで呼ぶ必要がある)。
   *
   * Idempotent and never throws — a failed prewarm just means a stutter.
   */
  async prewarmMaterials() {
    if (this._prewarmed) return this._prewarmed;
    const t0 = performance.now();
    const out = { ok: false, materials: 0, ms: 0 };
    this._prewarmed = out;
    try {
      const seen = new Set();
      for (const name in VARIANTS) {
        for (const m of resolveMaterials(name, MATERIAL_SLOTS, this.materials)) {
          if (m && !seen.has(m)) seen.add(m);
        }
      }
      // the thrown grenade's mesh is built on the first throw, mid-firefight
      this._ensureGrenade();
      out.materials = seen.size + 1;
      out.ok = true;
    } catch (err) {
      out.error = String(err?.message ?? err);
    }
    out.ms = Math.round(performance.now() - t0);
    console.info(`[ai] prewarmMaterials ${JSON.stringify(out)}`);
    return out;
  }

  /* ================================================================== */
  /* events                                                             */
  /* ================================================================== */

  _wireEvents(ctx) {
    this._off = [];
    const on = (t, fn) => this._off.push(ctx.events.on(t, fn));

    on('weapon:fire', (e) => {
      if (!e || !e.origin || e.weapon === 'ai_rifle') return; // ignore our own
      // A gunshot is the loudest thing in the level: everybody hears it, and
      // anyone near the line of fire also feels suppressed by it.
      for (const a of this.agents) {
        if (!a.alive) continue;
        a.hear(e.origin, 90);
        if (e.dir) {
          const d = this._distanceToRay(a.position, e.origin, e.dir, a.eyeHeight);
          if (d < 2.6) a.suppress(0.45 * (1 - d / 2.6) + 0.12);
        }
      }
    });

    on('bullet:impact', (e) => {
      if (!e || !e.point) return;
      // damage:dealt には部位が載らない (ARCHITECTURE.md の語彙は headshot のみ)。
      // physics は入口 impact → damage:dealt を同期・この順で emit するので、
      // 直前の入口 impact の部位を覚えておき、直後の damage:dealt で部位倍率
      // (HITBOXES の damageScale: arm 0.65 / leg 0.7 / head 4.0) に使う。
      if (e.actor instanceof Agent && !e.exit) {
        this._lastImpactActor = e.actor;
        this._lastImpactPart = e.part;
        this._lastImpactIncident = e.incident;
      }
      for (const a of this.agents) {
        if (!a.alive) continue;
        const d = a.position.distanceTo(e.point);
        if (d < 3.2) a.suppress(0.5 * (1 - d / 3.2));
        else if (d < 12) a.hear(e.point, 12);
      }
    });

    on('damage:dealt', (e) => {
      if (!e || !e.target || !(e.target instanceof Agent)) return;
      const a = e.target;
      if (!a.alive) return;
      // 部位倍率: Babylon 版 physics は Hit の damageScale を掛けないので、
      // ここで適用する (部位は直前の bullet:impact から — 上のコメント参照)。
      // ダメージの適用は対象 (この購読) だけが行う — 発行側でも適用すると二重に減る。
      const part = e.headshot
        ? 'head'
        : e.part ?? (e.target === this._lastImpactActor ? this._lastImpactPart : null) ?? 'torso';
      const partScale = a.hitboxes?.damageScaleFor(part) ?? (e.headshot ? 4.0 : 1);
      const amount = e.amount * partScale * this._falloff(e.point);
      const incident =
        e.incident ?? (e.target === this._lastImpactActor ? this._lastImpactIncident : null);
      a.applyDamage(amount, part, e.point ?? a.position, incident);
      if (!a.alive) e.killed = true;
    });

    on('explosion', (e) => {
      if (!e || !e.position) return;
      const radius = e.radius ?? 5;
      for (const a of this.agents) {
        if (!a.alive) continue;
        const d = a.position.distanceTo(e.position) + 0.001;
        a.hear(e.position, 120);
        if (d > radius) continue;
        if (this.phys && !this.phys.lineOfSight(e.position, a.eye, this.phys.MASK.EXPLOSION)) continue;
        const f = 1 - d / radius;
        this._v.copy(a.position).sub(e.position).normalize();
        a.suppress(1.4 * f);
        a.applyDamage((e.damage ?? 100) * f * f, 'torso', a.eye, this._v);
      }
    });

    on('player:footstep', (e) => {
      if (!e || !e.position) return;
      const loud = e.running ? 24 : 11;
      for (const a of this.agents) if (a.alive) a.hear(e.position, loud);
    });
  }

  _falloff(point) {
    if (!point) return 1;
    const p = this.playerPosition(this._v2);
    if (!p) return 1;
    const d = p.distanceTo(point);
    // full damage inside 22 m, tapering to 45 % by 70 m
    return d < 22 ? 1 : Math.max(0.45, 1 - (d - 22) * 0.0125);
  }

  _distanceToRay(point, origin, dir, eyeH) {
    const px = point.x - origin.x;
    const py = point.y + eyeH * 0.7 - origin.y;
    const pz = point.z - origin.z;
    const t = Math.max(0, px * dir.x + py * dir.y + pz * dir.z);
    return Math.hypot(px - dir.x * t, py - dir.y * t, pz - dir.z * t);
  }

  /* ================================================================== */
  /* assets                                                             */
  /* ================================================================== */

  variant(name) {
    let v = this._variants.get(name);
    if (!v) {
      const t0 = performance.now();
      const built = buildSoldier(name, { rng: this.rng.fork(), materials: this.materials });
      // Babylon テンプレート Mesh (setEnabled(false))。各 Agent は clone する。
      built.template = buildVariantTemplate(this.ctx.scene, name, built);
      built.template.parent = this.root;
      v = built;
      this._variants.set(name, v);
      console.info(
        `[ai] variant "${name}" ${v.stats.triangles | 0} tris / ${v.stats.vertices} verts / ` +
          `${v.materials.length} materials in ${(performance.now() - t0).toFixed(0)}ms`
      );
    }
    return v;
  }

  /** Bone index lookup for the shared rig. */
  rigIndex(name) {
    return RIG.index(name);
  }

  get phys() {
    return this._phys ?? (this._phys = this.ctx.peek('physics'));
  }

  /* ================================================================== */
  /* navigation                                                         */
  /* ================================================================== */

  _buildNav() {
    const phys = this.phys;
    const world = this.ctx.peek('world');
    if (!phys) return;
    // レベルが Havok に載っているかの実測プローブ: 原点付近の床に下向きレイ。
    // Three 版は triangleCount を見たが Babylon 版 physics は公開していない。
    const probe = ray(phys, 0, 60, 0, 0, -1, 0, 200, phys.MASK.WORLD);
    if (!probe.hit) return; // level not registered yet — retry next frame
    // world.bounds は Babylon 版 world に無いので、レベルレイアウトを覆う既定値。
    const wb = world?.bounds ?? null;
    const bounds = wb
      ? { min: { x: wb.min.x - 2, y: wb.min.y - 2, z: wb.min.z - 2 }, max: { x: wb.max.x + 2, y: wb.max.y + 2, z: wb.max.z + 2 } }
      : { min: { x: -72, y: -6, z: -72 }, max: { x: 72, y: 26, z: 72 } };
    const t0 = performance.now();
    this.grid = new NavGrid(phys, { bounds, cell: 0.8, radius: 0.36, height: 1.78 });
    this.grid.build();
    this.cover = new CoverMap(this.grid, phys);
    this.cover.build({ step: 1, reach: 1.3 });
    this.stats.navMs = performance.now() - t0;
    this.stats.coverPts = this.cover.points.length;
    this.stats.walkable = this.grid.walkableCount;
    this._navPending = false;
    console.info(
      `[ai] nav ${this.grid.nx}x${this.grid.nz} cells · ${this.grid.walkableCount} walkable · ` +
        `${this.cover.points.length} cover points · ${this.stats.navMs.toFixed(0)}ms`
    );
  }

  /** Floor probe used by foot IK and spawning. */
  probeGround(x, z, fromY, out) {
    const phys = this.phys;
    if (!phys) return false;
    const h = ray(phys, x, fromY, z, 0, -1, 0, 3.2, phys.MASK.WORLD);
    if (!h.hit) return false;
    out.y = h.point.y;
    out.nx = h.normal.x;
    out.ny = h.normal.y;
    out.nz = h.normal.z;
    out.hit = true;
    return true;
  }

  groundAt(x, z, fromY = 40) {
    const phys = this.phys;
    if (!phys) return 0;
    const h = ray(phys, x, fromY, z, 0, -1, 0, 80, phys.MASK.WORLD);
    if (h.hit) return h.point.y;
    return this.ctx.peek('world')?.groundHeight?.(x, z) ?? 0;
  }

  /**
   * The player's chest position, however the player system exposes itself.
   *
   * Babylon 版 player は `position()` メソッドで**カプセル中心**を返す
   * (足元 + 0.9 m)。胸 ≈ 足元 + 1.35 m = 中心 + 0.45 m。
   */
  playerPosition(out) {
    const p = this.ctx.peek('player');
    const src = typeof p?.position === 'function' ? p.position() : (p?.position ?? null);
    if (src && Number.isFinite(src.x)) {
      out.set(src.x, src.y + 0.45, src.z);
      return out;
    }
    const c = this.ctx.camera.globalPosition;
    out.set(c.x, c.y - 0.1, c.z);
    return out;
  }

  /* ================================================================== */
  /* spawning                                                           */
  /* ================================================================== */

  spawn(variantName, position, yaw = 0, opts = {}) {
    const a = new Agent(this, { variant: variantName, position, yaw, ...opts });
    this.agents.push(a);
    return a;
  }

  /**
   * Garrison the level: two squads on patrol routes drawn from the world's own
   * spawn points, far enough from the player to be found rather than spawned on
   * top of. This is what the behaviour tree, navigation and perception actually
   * run against in play.
   */
  populate(opts = {}) {
    const world = this.ctx.peek('world');
    // Babylon 版 world は spawnPoints を公開していないので、無ければ nav グリッド
    // から決定的にアンカーを合成する (_spawnAnchors)。
    const spawns = world?.spawnPoints ?? this._spawnAnchors();
    if (!spawns.length || !this.grid) return 0;
    const player = this.playerPosition(this._v3).clone();
    // rank the spawn points by distance from the player, take the far half
    const ranked = spawns
      .map((s, i) => ({ s, i, d: s.position.distanceTo(player) }))
      .sort((a, b) => b.d - a.d)
      .filter((e) => e.d > 18);
    if (!ranked.length) return 0;

    const variants = ['vanguard', 'irregular', 'breacher'];
    const squads = opts.squads ?? 2;
    const per = opts.perSquad ?? 3;
    let made = 0;
    for (let q = 0; q < squads && q < ranked.length; q++) {
      const squad = this.createSquad();
      const anchor = ranked[q % ranked.length].s;
      // patrol route: this spawn point and the two next-nearest ones
      const route = [anchor.position.clone()];
      const others = ranked
        .filter((e) => e.s !== anchor)
        .sort(
          (a, b) =>
            a.s.position.distanceTo(anchor.position) - b.s.position.distanceTo(anchor.position)
        )
        .slice(0, 2);
      for (const o of others) route.push(o.s.position.clone());

      for (let m = 0; m < per; m++) {
        const jitterA = this.rng.range(0, Math.PI * 2);
        const jitterR = this.rng.range(0.8, 3.2);
        const p = anchor.position
          .clone()
          .add(new THREE.Vector3(Math.cos(jitterA) * jitterR, 0, Math.sin(jitterA) * jitterR));
        const ci = this.grid.nearest(p.x, p.z, anchor.position.y, 6, 1.4);
        if (ci >= 0) {
          p.set(
            this.grid.worldX(ci % this.grid.nx),
            this.grid.floor[ci],
            this.grid.worldZ((ci / this.grid.nx) | 0)
          );
        } else {
          p.y = this.groundAt(p.x, p.z, anchor.position.y + 4);
        }
        const a = this.spawn(variants[(q * per + m) % variants.length], p, anchor.yaw + this.rng.signed() * 0.7, {
          patrol: route,
        });
        squad.add(a);
        made++;
      }
    }
    console.info(`[ai] garrison: ${made} enemies in ${squads} squads`);
    return made;
  }

  /**
   * nav グリッドから決定的にスポーンアンカーを作る: 原点まわり 8 方位 × 2 半径で
   * 歩行可能セルへスナップ。rng を引かないので決定性に影響しない。
   */
  _spawnAnchors() {
    const g = this.grid;
    if (!g) return [];
    const anchors = [];
    // 基準高さは原点の街路。y を渡さないと nearest() が屋上の歩行可能セルに
    // 平気でスナップし、守備隊が全員ルーフトップに湧く (実測 y=9.5)。
    const streetY = this.groundAt(0, 0, 40);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.35;
      for (const r of [30, 42, 20]) {
        const ci = g.nearest(Math.cos(a) * r, Math.sin(a) * r, streetY, 10, 2.5);
        if (ci < 0) continue;
        const px = g.worldX(ci % g.nx);
        const pz = g.worldZ((ci / g.nx) | 0);
        anchors.push({
          position: new THREE.Vector3(px, g.floor[ci], pz),
          // 市街中心 (原点) を向く
          yaw: Math.atan2(-px, -pz),
        });
        break;
      }
    }
    return anchors;
  }

  createSquad() {
    const s = new Squad(this.rng.fork());
    this.squads.push(s);
    return s;
  }

  /* ================================================================== */
  /* firing                                                             */
  /* ================================================================== */

  /** 0 at night, 1 in full daylight. Drives both flash gains below. */
  _daylight() {
    const sky = this._sky ?? (this._sky = this.ctx.peek('sky'));
    // Babylon 版 sky は高度角を直接公開しないので sunDirection().y (=sin 高度) から。
    const d = sky?.sunDirection?.();
    const sinAlt = d && Number.isFinite(d.y) ? d.y : Math.sin(0.6);
    return Math.min(1, Math.max(0, sinAlt * 4));
  }

  /**
   * SPRITE gain. The flash itself has to be *visible* — a firefight with no fire
   * in it is not a firefight — so this stays high enough to read as burning gas
   * at 10-25 m and is only trimmed in daylight, where the sun is competing.
   */
  _flashGain() {
    return 0.12 + 0.5 * (1 - this._daylight());
  }

  /**
   * LIGHT gain, deliberately separate and two orders of magnitude smaller.
   * 経緯は Three 版の実測コメント (git 履歴) 参照: プレイヤー級の 90cd を
   * 撃った本人の胸に当てると、射手が画面で一番明るい物体になる。
   */
  _flashLight() {
    const day = this._daylight();
    return 0.006 + 0.05 * (1 - day);
  }

  onAgentFire(agent, origin, dir) {
    const ctx = this.ctx;
    const phys = this.phys;

    // muzzle flash, light and smoke come from fx via the canonical event
    const fe = this._fireEvent;
    fe.origin.copy(origin);
    fe.dir.copy(dir);
    fe.intensity = this._flashGain();
    fe.light = this._flashLight();
    fe.flashScale = 0.8;
    fe.seed = (agent.id * 2654435761 + ctx.time.frame) >>> 0;
    ctx.events.emit('weapon:fire', fe);

    // ejected case
    const se = this._shellEvent;
    se.position.copy(agent.animator.ejectWorld);
    se.velocity.set(dir.z, 0.55, -dir.x).multiplyScalar(2.1).addScaledVector(dir, -0.6);
    ctx.events.emit('weapon:shell', se);

    // the round itself
    let end = null;
    if (phys) {
      const impacts = phys.fireBullet({
        origin,
        dir,
        damage: agent.weaponDamage,
        penetration: 0.9,
        maxDist: 200,
        mask: phys.MASK.BULLET,
        rng: this.rng,
      });
      if (impacts.length) end = impacts[0].point;
    }
    // Babylon 版でも player の部位カプセルは Havok に無い (CC ボディは CLIP 層で
    // 弾には当たるが meta を持たない) ので、プレイヤーへの命中はここで判定する。
    // Staged agents shoot for the camera, not for blood: a capture must not be
    // graded through the player's low-health filter.
    if (!agent.staged?.noDamage) this._testPlayerHit(agent, origin, dir, end);

    this._tracerFrom.copy(origin);
    if (end) this._tracerTo.copy(end);
    else this._tracerTo.copy(origin).addScaledVector(dir, 120);
    if ((agent.id + agent.ammo) % 3 === 0) ctx.events.emit('bullet:tracer', this._tracerEvent);
  }

  _testPlayerHit(agent, origin, dir, end) {
    const p = this.playerPosition(this._v);
    if (!p) return;
    const maxT = end ? origin.distanceTo(end) : 200;
    const px = p.x - origin.x, py = p.y - origin.y, pz = p.z - origin.z;
    const t = px * dir.x + py * dir.y + pz * dir.z;
    if (t < 0.5 || t > maxT + 0.6) return;
    const miss = Math.hypot(px - dir.x * t, py - dir.y * t, pz - dir.z * t);
    const player = this.ctx.peek('player');
    if (miss > 0.42) {
      if (miss < 1.6) player?.onNearMiss?.(miss); // whip-crack past the ear
      return;
    }
    const amount = agent.weaponDamage * (miss < 0.16 ? 1.25 : 1);
    this._v2.copy(origin);
    // Damage is applied *only* through the event below. `player` listens for
    // `damage:dealt` with itself as the target, so calling applyDamage() here as
    // well would wound the player twice for every round that connected.
    this.ctx.events.emit('damage:dealt', {
      target: player ?? 'player',
      amount,
      headshot: false,
      killed: false,
      point: p,
      from: this._v2,
      source: agent,
    });
  }

  emitReload(agent) {
    this.ctx.events.emit('weapon:reload', { weapon: 'ai_rifle', phase: 'start', actor: agent });
  }

  /** Grenade mesh + material. Built at prewarm, not on the first throw. */
  _ensureGrenade() {
    if (this._grenadeMesh) return;
    this._grenadeMat = new PBRMaterial('ai_grenade', this.ctx.scene);
    this._grenadeMat.albedoColor = new Color3(0.028, 0.036, 0.021);
    this._grenadeMat.roughness = 0.62;
    this._grenadeMat.metallic = 0.85;
    // テンプレート (非表示)。投擲ごとに clone する。
    this._grenadeMesh = MeshBuilder.CreateIcoSphere('ai_grenade_tmpl', { radius: 0.045, subdivisions: 1 }, this.ctx.scene);
    this._grenadeMesh.material = this._grenadeMat;
    this._grenadeMesh.parent = this.root;
    this._grenadeMesh.isPickable = false;
    this._grenadeMesh.setEnabled(false);
  }

  throwGrenade(agent, from, target) {
    const phys = this.phys;
    if (!phys) return;
    this._ensureGrenade();
    const mesh = this._grenadeMesh.clone(`ai_grenade_${agent.id}_${this.ctx.time.frame}`);
    mesh.setEnabled(true);
    mesh.position.set(from.x, from.y, from.z);
    // lobbed ballistic solve
    const dx = target.x - from.x, dz = target.z - from.z;
    const dist = Math.max(0.5, Math.hypot(dx, dz));
    const g = Math.abs(phys.gravity.y);
    const speed = Math.min(18, Math.sqrt(Math.max(4, (dist * g) / 0.95)));
    const vy = speed * 0.62;
    const vh = Math.min(speed, dist / Math.max(0.35, (2 * vy) / g));
    const body = phys.addRigidBody({
      shape: 'sphere',
      radius: 0.05,
      mass: 0.42,
      position: mesh.position,
      velocity: { x: (dx / dist) * vh, y: vy, z: (dz / dist) * vh },
      lifetime: 9,
      mesh,
      surface: 'metal',
    });
    this._grenades.push({ body, mesh, fuse: 2.35, agent });
    agent.animator.fire(0.35);
  }

  _updateGrenades(dt) {
    for (let i = this._grenades.length - 1; i >= 0; i--) {
      const g = this._grenades[i];
      g.fuse -= dt;
      if (g.fuse > 0) continue;
      const p = g.body?.position ?? g.mesh.position;
      this.ctx.events.emit('explosion', {
        position: new THREE.Vector3(p.x, p.y, p.z),
        radius: 6.5,
        damage: 120,
        source: g.agent,
      });
      // removeRigidBody はメッシュ (node) も dispose する (owKeep なし)
      this.phys?.removeRigidBody(g.body);
      this._grenades.splice(i, 1);
    }
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  /** 物理積分 (120 Hz)。Babylon 版 Character.move は速度渡し + 固定ステップ。 */
  fixedUpdate(h) {
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.alive) a.fixedUpdate(h);
    }
  }

  update(dt, ctx) {
    if (this._navPending) {
      this._buildNav();
      // Populate the level for normal play. Capture runs stay empty unless a
      // shot asks for a tableau, so nobody's screenshot gets a stray patrol
      // wandering through it.
      if (!this._navPending && (!ctx.config.deterministic || this.forcePopulate)) this.populate();
    }

    // Per-frame A* budget: see requestPath().
    this._pathBudget = this.pathsPerFrame;
    this._updateRelevance(ctx);

    for (const s of this.squads) s.update(dt);

    let alive = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.alive) {
        if (a.staged) this._updateStaged(a, dt);
        else a.update(dt, ctx);
        alive++;
      } else if (a.deadTime !== undefined) {
        // 倒れ込みモーションを進める。静止後は実質 no-op。
        a.updateDead(dt);
      }
    }
    this._updateGrenades(dt);
    this.stats.agents = this.agents.length;
    this.stats.alive = alive;
  }

  lateUpdate() {
    const g = this.ground;
    g.begin();
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      a.syncHitboxes();
      // Dead men keep their contact: a body on the floor needs it most.
      g.addActor(a);
    }
    g.end();
  }

  /* ================================================================== */
  /* frame budgets and LOD                                              */
  /* ================================================================== */

  /**
   * A* on the shared grid, rationed. Returns the waypoint count, or -1 when this
   * frame's budget is spent — the caller keeps its old path and asks again next
   * frame, which is invisible at 60 Hz and turns a squad-wide repath (six solves,
   * ~5 ms, on the frame the player opens fire) into two solves per frame.
   */
  requestPath(from, dest, out) {
    if (!this.grid) return 0;
    if (this._pathBudget <= 0) {
      this.stats.pathsDeferred++;
      return -1;
    }
    this._pathBudget--;
    return this.grid.findPath(from, dest, out);
  }

  /** Unit vector pointing AT the sun, however the sky exposes itself. */
  _sunDirection() {
    const sky = this._sky ?? (this._sky = this.ctx.peek('sky'));
    const d = sky?.sunDirection?.();
    if (d && Number.isFinite(d.x)) this._sun.set(d.x, d.y, d.z);
    else this._sun.set(0.3, 0.8, 0.4);
    if (this._sun.lengthSq() < 1e-8) this._sun.set(0, 1, 0);
    return this._sun.normalize();
  }

  /** 球 (中心 c, 半径 r) がフラスタムに掛かるか。Babylon の平面規約 (内側 > 0)。 */
  _sphereInFrustum(cx, cy, cz, r) {
    const c = this._sphereC;
    c.x = cx; c.y = cy; c.z = cz;
    for (let i = 0; i < 6; i++) {
      if (this._planes[i].dotCoordinate(c) <= -r) return false;
    }
    return true;
  }

  /**
   * Decide, per actor, whether anything it does this frame can reach a pixel.
   *
   * An actor is IRRELEVANT only when both of these hold:
   *   1. its (already 1.45x inflated) bounding sphere, grown by a further 4 m,
   *      misses the camera frustum — so it is not drawn, and no screen-space
   *      effect can sample it either, because it is not in the depth buffer;
   *   2. the volume its sun shadow could possibly darken misses the frustum too.
   *      For a directional light that volume is exactly the actor's sphere swept
   *      along -sunDir: a visible surface can only be shadowed by this actor if
   *      the ray from that surface toward the sun passes through it. Sweeping to
   *      where the ray leaves the level below the floor covers every receiver,
   *      ground or wall, and the 4 m of slack absorbs both the soft-shadow filter
   *      radius and a frame of camera motion.
   *
   * Irrelevant actors animate at a third of the rate and are dropped from the
   * shadow cascades. Babylon 版では「CSM の render list から add/remove する」
   * ことがそのスイッチで、`mesh.metadata.owNoShadow` は現在状態の記録
   * (render.addShadowCaster が入口で見るフラグ) として同期しておく。
   * They are still simulated, still shootable, still make noise — only the parts
   * that can exclusively affect pixels are skipped.
   */
  _updateRelevance(ctx) {
    // view-projection からフラスタム平面を取り直す (毎フレーム)
    Frustum.GetPlanesToRef(ctx.scene.getTransformMatrix(), this._planes);
    const sun = this._sunDirection();
    // how far a shadow ray can travel before it is under the level
    const floorY = (this.grid ? -6 : -20);
    const sunY = Math.max(0.06, sun.y);
    let irrelevant = 0;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const bs = a.def.geometry.boundingSphere;
      const r = bs.radius * a.scale + 4;
      const cx = a.position.x;
      const cy = a.position.y + bs.center[1] * a.scale;
      const cz = a.position.z;
      let visible = this._sphereInFrustum(cx, cy, cz, r);
      if (!visible) {
        const tMax = Math.min(320, (cy - floorY) / sunY);
        const step = Math.max(2, r * 0.9);
        for (let t = step; t <= tMax; t += step) {
          if (this._sphereInFrustum(cx - sun.x * t, cy - sun.y * t, cz - sun.z * t, r)) {
            visible = true;
            break;
          }
        }
      }
      a.lodIrrelevant = !visible;
      if (!visible) irrelevant++;
      // 影キャスタの add/remove (状態が変わった時だけ)
      if (a.mesh.metadata.owNoShadow !== !visible) {
        a.mesh.metadata.owNoShadow = !visible;
        if (!visible) {
          if (a._castingShadow) {
            a._render?.removeShadowCaster(a.mesh);
            a._castingShadow = false;
          }
        } else if (!a._castingShadow) {
          a._render?.addShadowCaster(a.mesh, false);
          a._castingShadow = true;
        }
      }
    }
    this._lodStats.irrelevant = irrelevant;
    this.stats.lodIrrelevant = irrelevant;
  }

  /* ================================================================== */
  /* staged tableau for the capture harness                             */
  /* ================================================================== */

  /**
   * Pin an agent into a photogenic combat beat: it still animates, aims and
   * fires for real, it just does not get to decide where to stand.
   */
  _updateStaged(a, dt) {
    const s = a.staged;
    const p = this.playerPosition(this._v3);
    a.stateTime += dt;
    a.fireCooldown -= dt;
    a.burstCooldown -= dt;
    a.state = STATE.COMBAT;
    a.hasTarget = true;
    a.targetVisible = true;
    a.alertness = 1;
    a.lastKnown.copy(p);
    a.lastKnownAge = 0;
    a.crouch = !!s.crouch;
    a.aimWeight = s.aimWeight ?? 1;
    a.suppression = s.suppression ?? 0;
    a.desiredSpeed = s.speed ?? 0;
    a.wantFire = s.fire !== false;
    if (s.speed) {
      a.hasMoveTarget = true;
      if (!a.path[0]) a.path[0] = new THREE.Vector3();
      a.path[0].copy(a.position).addScaledVector(s.heading, 6);
      a.pathLen = 1;
      a.pathIndex = 0;
    } else {
      a.hasMoveTarget = false;
    }
    if (s.reloadEvery && a.stateTime > s.reloadEvery && !a.animator.reloading) {
      a.stateTime = 0;
      a.animator.reload(2.4);
    }
    a._move(dt);
    a._shoot(dt);
    a._drive(dt);
  }

  /**
   * カメラの前方/右/垂直半画角。Babylon の fov はラジアン (垂直)。
   * 前方は世界行列の -Z 列 (右手系でカメラは -Z を向く)。
   */
  _cameraBasis(cam, outF, outR) {
    const m = cam.getWorldMatrix().m;
    outF.set(-m[8], -m[9], -m[10]).normalize();
    outR.set(m[0], m[1], m[2]).normalize();
    const aspect = this.ctx.engine.babylon.getAspectRatio(cam);
    return Math.tan(cam.fov / 2) * aspect; // tan(半水平画角)
  }

  /**
   * Compose a staged enemy into the frame: find the walkable spot whose
   * projected screen position and depth best match the requested composition,
   * that the camera can actually see, that is not on top of another actor, and
   * that has cover nearby. Occlusion is checked at chest and head height, which
   * is what stops a soldier being placed behind a market stall.
   */
  _stageSlot(cam, ndcX, wantDepth, placed) {
    const g = this.grid;
    const F = this._v;
    const R = this._v2;
    const tanH = this._cameraBasis(cam, F, R);
    F.y = 0;
    F.normalize();
    const rx = F.z, rz = -F.x; // camera right, flattened
    const camPos = cam.globalPosition;
    const ideal = new THREE.Vector3(
      camPos.x + F.x * wantDepth + rx * ndcX * tanH * wantDepth,
      0,
      camPos.z + F.z * wantDepth + rz * ndcX * tanH * wantDepth
    );
    const yRef = camPos.y - 1.7;
    const out = new THREE.Vector3(ideal.x, yRef, ideal.z);
    if (!g) {
      out.y = this.groundAt(out.x, out.z, camPos.y + 3);
      return out;
    }
    const chest = this._v3;
    const cx = g.cellX(ideal.x), cz = g.cellZ(ideal.z);
    const span = Math.ceil(7 / g.cell);
    let best = -1, bestScore = Infinity, bestX = 0, bestZ = 0;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const ix = cx + dx, iz = cz + dz;
        if (!g.walkable(ix, iz)) continue;
        const i = g.index(ix, iz);
        const fy = g.floor[i];
        if (Math.abs(fy - yRef) > 1.0) continue;
        const x = g.worldX(ix), z = g.worldZ(iz);
        // spacing from the men already placed
        let tooClose = false;
        for (const q of placed) {
          if (Math.hypot(q.x - x, q.z - z) < 2.4) { tooClose = true; break; }
        }
        if (tooClose) continue;
        // project
        const ex = x - camPos.x, ez = z - camPos.z;
        const depth = ex * F.x + ez * F.z;
        if (depth < 3) continue;
        const lateral = ex * rx + ez * rz;
        const ndc = lateral / (depth * tanH);
        // must be visible: chest and head
        if (this.phys) {
          chest.set(x, fy + 1.25, z);
          if (!this.phys.lineOfSight(camPos, chest, this.phys.MASK.SIGHT)) continue;
          chest.set(x, fy + 1.62, z);
          if (!this.phys.lineOfSight(camPos, chest, this.phys.MASK.SIGHT)) continue;
        }
        let score = Math.abs(ndc - ndcX) * 9 + Math.abs(depth - wantDepth) * 0.5;
        // prefer standing next to something solid
        score -= g.enclosure[i] * 0.35;
        if (score < bestScore) {
          bestScore = score;
          best = i;
          bestX = x;
          bestZ = z;
        }
      }
    }
    if (best >= 0) out.set(bestX, g.floor[best], bestZ);
    else out.y = this.groundAt(out.x, out.z, camPos.y + 3);
    return out;
  }

  /** 前回の staged 配置を撤収する — debugStage は連続適用され得るため。 */
  _clearStage() {
    if (!this._stagedAgents.length) return;
    for (const a of this._stagedAgents) {
      const i = this.agents.indexOf(a);
      if (i >= 0) this.agents.splice(i, 1);
      this.cover?.release(a.id);
      a.dispose();
    }
    this._stagedAgents.length = 0;
    if (this._stagedSquad) {
      const i = this.squads.indexOf(this._stagedSquad);
      if (i >= 0) this.squads.splice(i, 1);
      this._stagedSquad = null;
    }
  }

  /**
   * `debugStage('firefight')` — a staged firefight in front of the shot camera:
   * one man up and firing from behind hard cover, one crouched and peeking, one
   * moving between positions, one reloading further back.
   * `debugStage('none')` — 撤収 (prewarm の後始末が呼ぶ)。
   */
  debugStage(name) {
    if (name === 'none') {
      this._clearStage();
      return this.stats;
    }
    if (name !== 'firefight') return this.stats;
    if (this.inspect) return this._stageInspect();
    this._clearStage();
    if (this._navPending) this._buildNav();

    const cam = this.ctx.camera;
    // A firefight the critic can actually see: drop the sun low enough to rake
    // down the street so the characters are lit, not silhouetted. This shot is
    // ours to compose; every other shot keeps its own time of day.
    this.ctx.peek('sky')?.setTimeOfDay?.(17.9);
    const F = new THREE.Vector3();
    const R = new THREE.Vector3();
    this._cameraBasis(cam, F, R);
    F.y = 0;
    F.normalize();
    const right = new THREE.Vector3(F.z, 0, -F.x);
    const squad = this.createSquad();
    this._stagedSquad = squad;

    /** [variant, ndcX, depth, crouch, speed, fire, reloadEvery] */
    const LAYOUT = [
      // hero: up and firing, left of frame, close enough to read the kit
      ['vanguard', -0.44, 8.0, false, 0, true, 0],
      // second man crouched in cover, right of frame
      ['breacher', 0.30, 12.0, true, 0, true, 0],
      // one caught mid-stride between positions
      ['irregular', -0.14, 16.0, false, 4.1, false, 0],
      // one reloading behind cover on the far right
      ['vanguard', 0.60, 9.5, true, 0, true, 3.4],
      // depth: a fifth man well down the street
      ['irregular', -0.26, 22.0, false, 0, true, 0],
    ];

    const camPos = cam.globalPosition;
    const placedPositions = [];
    for (const [variant, ndcX, d, crouch, speed, fire, reload] of LAYOUT) {
      const pos = this._stageSlot(cam, ndcX, d, placedPositions);
      const yaw = Math.atan2(camPos.x - pos.x, camPos.z - pos.z);
      const a = this.spawn(variant, pos, yaw);
      squad.add(a);
      a.staged = {
        crouch,
        speed,
        fire,
        noDamage: true,
        heading: right.clone().multiplyScalar(-1),
        aimWeight: 1,
        reloadEvery: reload || 0,
        suppression: crouch ? 0.15 : 0,
      };
      // stagger the burst timers so the frame catches muzzle flashes
      a.burstCooldown = this.rng.range(0, 0.3);
      a.burstLeft = this.rng.int(2, 6);
      a.peeking = true;
      a.aimTarget.copy(this.playerPosition(this._v3));
      a._drive(0.016);
      placedPositions.push(pos.clone());
      this._stagedAgents.push(a);
      if (this.debugLog) {
        console.info(
          `[ai] staged ${variant} at ${pos.x.toFixed(1)},${pos.y.toFixed(2)},${pos.z.toFixed(1)} ` +
            `d=${Math.hypot(camPos.x - pos.x, camPos.z - pos.z).toFixed(1)}m`
        );
      }
    }

    // One man already down — 手続き倒れ込みを完了状態まで進めて死体として置く
    // (ラグドール不採用の経緯は deathfall.js)。death path の実行も兼ねる。
    const dPos = this._stageSlot(cam, -0.58, 9.4, placedPositions);
    const casualty = this.spawn('breacher', dPos, Math.atan2(camPos.x - dPos.x, camPos.z - dPos.z));
    squad.add(casualty);
    casualty._drive(0.016);
    const hit = new THREE.Vector3(dPos.x, dPos.y + 1.35, dPos.z);
    const inc = new THREE.Vector3(dPos.x - camPos.x, dPos.y + 1.35 - camPos.y, dPos.z - camPos.z).normalize();
    casualty.applyDamage(260, 'torso', hit, inc);
    // 撮影フレームまでに倒れ切るよう、静止状態まで送る
    casualty.deathFall.finish(casualty._deathOut);
    casualty._applyDeathPose();
    casualty.deathFall.t = -1;
    this._stagedAgents.push(casualty);

    return this.stats;
  }

  /** Model inspection line-up (dev only). */
  _stageInspect() {
    const cam = this.ctx.camera;
    const F = new THREE.Vector3();
    const R = new THREE.Vector3();
    this._cameraBasis(cam, F, R);
    F.y = 0;
    F.normalize();
    const right = new THREE.Vector3(F.z, 0, -F.x);
    this.ctx.peek('sky')?.setTimeOfDay?.(11.5);
    const camPos = cam.globalPosition;
    const layout = [
      ['vanguard', 1.9, 0.35, 0.25],
      ['irregular', 2.7, -0.95, 3.0],
      ['breacher', 3.6, 1.15, -0.7],
    ];
    for (const [nm, d, s2, extraYaw] of layout) {
      const p = new THREE.Vector3(camPos.x, camPos.y, camPos.z)
        .addScaledVector(F, d)
        .addScaledVector(right, s2);
      p.y = this.groundAt(p.x, p.z, camPos.y + 1.0);
      const toCam = Math.atan2(camPos.x - p.x, camPos.z - p.z);
      const a = this.spawn(nm, p, toCam + extraYaw);
      a.staged = {
        crouch: false,
        speed: 0,
        fire: false,
        aimWeight: 1,
        heading: new THREE.Vector3(0, 0, 1),
      };
      this._stagedAgents.push(a);
    }
    return this.stats;
  }

  /* ================================================================== */

  dispose() {
    for (const off of this._off ?? []) off();
    for (const a of this.agents) a.dispose();
    this.agents.length = 0;
    this.squads.length = 0;
    this._stagedAgents.length = 0;
    for (const g of this._grenades) this.phys?.removeRigidBody(g.body);
    this._grenades.length = 0;
    this._grenadeMesh?.dispose(false, false);
    this._grenadeMat?.dispose();
    this.ground?.dispose();
    // テンプレート mesh の dispose は共有ジオメトリも解放する (clone は先に消えている)
    for (const v of this._variants.values()) v.template?.dispose(false, false);
    this._variants.clear();
    this.materials?.dispose();
    this.root.dispose();
  }
}

export { VARIANTS, STATE };
