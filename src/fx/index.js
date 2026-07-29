import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';

import { bakeAtlases, P, D, ATLAS_COLS } from './atlas.js';
import { ParticleLayer, resetSpawn, SP } from './particles.js';
import { DecalLayer } from './decals.js';
import { spawnImpact } from './impacts.js';
import { muzzleFlash as muzzleFlashRecipe } from './muzzle.js';
import { explode as explodeRecipe } from './explosions.js';
import { spawnTracer } from './tracers.js';
import { blackbody, C } from './util.js';

/**
 * FX — GPU パーティクル、デカール、曳光弾、マズルフラッシュ、爆発、着弾。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ## この移植で最も価値のあった発見
 *
 * `impacts.js` (936 行) / `muzzle.js` (473 行) / `explosions.js` (209 行) /
 * `tracers.js` (91 行) / `util.js` (184 行) は **Three.js に一切依存していません**。
 * これらは「12 種の surface ごとに、どんな粒子をどんな速度・寿命・色で撒くか」という
 * レシピの塊で、`fx.emitAdd(...)` のような **このクラスが提供する API しか呼びません**。
 *
 * したがって移植でやるべきことは「同じ API を Babylon で提供する」ことだけで、
 * 2,051 行のレシピ (火花が鉄で散る、コンクリが白い粉を吐く、肉が霧になる、といった
 * 手で詰めた数値) は **1 行も書き換えずに生きます**。
 *
 * 逆に言えば **このクラスの API シグネチャを変えるとレシピが全部壊れます**。
 * 変更する場合はレシピ側の呼び出しをすべて確認してください。
 *
 * ### レシピが依存している API (契約)
 *
 *   fx.rng / fx.physics
 *   fx.emitAdd(SP)    加算合成の層へ 1 粒子
 *   fx.emitLit(SP)    ライティングされる層へ 1 粒子 (煙・埃)
 *   fx.addDecal(point, normal, opts)
 *   fx.haze(x,y,z, radius, grow, life, strength, tile?)
 *   fx.hazeRing(x,y,z, radius, grow, life, strength)
 *   fx.addSmokeColumn(x,y,z, o)
 *   fx.bloodSpatterBehind(point, incident)
 *   fx.scorch(x,y,z, radius)
 *   fx.sunWorld()     ワールド空間の太陽方向
 *   fx.viewFlash(x,y,z, r,g,b, strength)
 * ────────────────────────────────────────────────────────────────────────────
 */
export class FxSystem {
  static id = 'fx';
  static deps = ['render', 'materials', 'physics'];

  constructor() {
    /** レシピが参照する。 */
    this.rng = null;
    this.physics = null;
    /** WebGPU でない等でアトラスが焼けなかった場合 true。FX は無効。 */
    this.disabled = false;

    this._lights = [];
    this._lightCursor = 0;
    this._v = new Vector3();
    this._sun = new Vector3(0, 1, 0);
    this._sunView = new Vector3(0, 1, 0);
    this._upView = new Vector3(0, 1, 0);
    this._sunCol = new Vector3(1, 0.95, 0.86);
    this._ambTop = new Vector3(0.35, 0.42, 0.55);
    this._ambBot = new Vector3(0.16, 0.14, 0.12);
    this._fog = new Vector4(0.6, 0.65, 0.72, 0);
    this._amb = new Vector3(0.3, 0.34, 0.4);
  }

  async init(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.rng = ctx.rng.fork();
    this.physics = ctx.get('physics');
    this.render = ctx.get('render');

    const atlases = await bakeAtlases(ctx.scene, ctx.backend);
    if (!atlases) {
      this.disabled = true;
      // FX を無効化しても **レシピは呼ばれる** (イベントは流れる)。emit 系が
      // 存在しないと undefined 呼び出しで落ちるので、無効時でもバインドしておく。
      this._bindEmitters();
      this.pScale = 1;
      this.lights = { flash: () => {} };
      this._wireEvents(ctx);
      return;
    }
    this.atlases = atlases;

    const q = ctx.config.q;

    /**
     * ## パーティクル層は既定で無効 (既知の未解決バグ)
     *
     * **粒子を 1 つでも出すとフレーム全体が真っ黒になる。** エラーもワーニングも
     * 出ず、scene.getActiveIndices() は正常値を返し、キャンバスだけが黒くなる。
     * 実測: hero ショットの平均輝度 84.1 → 6.0。
     *
     * ### 排除済みの仮説 (すべて実測)
     *
     *  1. インスタンス属性が届いていない
     *     → geometry の instanced VertexBuffer では実際に全てゼロで届いた。
     *       thin instance に変え、さらに「1 粒子 4 頂点」の頂点属性方式にも
     *       変えたが、黒くなる症状は変わらない
     *  2. シェーダの出力が画面を塗り潰している
     *     → フラグメントを完全透明 (vec4f(0,0,0,0)) の固定出力にしても黒いまま。
     *       **描くこと自体**が問題で、出力内容ではない
     *  3. discard の後で dpdx/dpdy を呼んでいる (WGSL では不正)
     *     → 微分を discard より前に移したが変わらず (この修正自体は正しいので残置)
     *  4. bounding info 未同期で半透明ソートが壊れている
     *     → 有限の巨大 bounding box を与えたが変わらず
     *  5. GPU の検証エラー
     *     → ショット適用後のエラーはゼロ。以前観測した
     *       「PostProcessRTT-highlights の RenderPipeline が不正」は上流の
     *       別エラーの巻き添えだった
     *
     * ### 残る有力な仮説
     *
     * ShaderMaterial (needAlphaBlending) を HDR パイプラインの半透明パスに
     * 差し込むこと自体が、DefaultRenderingPipeline の合成と噛み合っていない可能性。
     * `?fxparticles=1` で有効化して調査を続けられる。
     *
     * **デカール・動的光源・弾痕は影響を受けないので有効のまま。** 着弾の
     * 弾痕と焦げ跡は出るが、火花と土煙が出ない状態で出荷している。
     */
    this.particlesEnabled = ctx.config.fxParticles === true;
    /**
     * 加算層と lit 層で予算を分ける。
     *
     * 加算 (火花・フラッシュ) は短命で数が少なく、lit (煙・埃) は長命で数が多い。
     * 同じリングに混ぜると、煙が火花を押し出して「撃っているのに火花が出ない」に
     * なるので必ず分ける。
     */
    if (!this.particlesEnabled) {
      console.warn(
        '[fx] パーティクル層は既定で無効です (既知の未解決バグ: 粒子を出すとフレーム全体が黒くなる)。' +
          ' ?fxparticles=1 で有効化できます。デカールと動的光源は動作します。'
      );
    }
    this.add = new ParticleLayer({
      capacity: Math.round(q.particleBudget * 0.35),
      mode: 'additive',
      atlas: atlases.particles,
      cols: atlases.cols,
      scene: ctx.scene,
    });
    this.lit = new ParticleLayer({
      capacity: Math.round(q.particleBudget * 0.65),
      mode: 'lit',
      atlas: atlases.particles,
      cols: atlases.cols,
      scene: ctx.scene,
    });
    this.decals = new DecalLayer({
      capacity: q.decalBudget,
      atlas: atlases.decals,
      cols: atlases.cols,
      scene: ctx.scene,
    });

    /**
     * レシピが参照する契約項目。**名前と形を変えないこと** (レシピ側が直接読む)。
     *
     *   fx.pScale  粒子数のスケール。品質プリセットで粒子の量を落とすための係数。
     *              レシピは `Math.round(n * fx.pScale)` の形で使う。
     *   fx.lights  動的光源。`flash(x,y,z, r,g,b, intensity, duration, decay, range, ?)`
     *   fx.ctx     レシピが camera を引くために使う (muzzle.js の screenAngle)
     */
    this.pScale = Math.max(0.25, q.particleBudget / 24000);
    this.lights = {
      flash: (x, y, z, r, g, b, intensity, duration, decay = 8, range = 8) =>
        this.flashLight(x, y, z, r, g, b, intensity, duration, decay, range),
    };

    this._bindEmitters();
    this._initLightPool(ctx);
    this._wireEvents(ctx);
  }

  /**
   * 動的光源のプール。
   *
   * マズルフラッシュや爆発の閃光に使う。**毎回 new せずプールから回す**のは、
   * ライトの生成/破棄がシーンのライトリストを触るため。
   *
   * Three 版はここで可視ライト数を固定する仕掛けを必要としていた (可視数が
   * シェーダの permutation key だったため) が、clustered lighting ではその制約が
   * 無い。強度 0 のまま置いておけばよい。
   */
  _initLightPool(ctx) {
    const N = 8;
    for (let i = 0; i < N; i++) {
      const l = new PointLight(`fxLight${i}`, new Vector3(0, -100, 0), ctx.scene);
      l.intensity = 0;
      l.range = 8;
      l.diffuse = new Color3(1, 0.8, 0.5);
      this.render.addLight(l);
      this._lights.push({ light: l, until: -1, peak: 0, start: 0, decay: 6 });
    }
  }

  _wireEvents(ctx) {
    ctx.events.on('bullet:impact', (e) => this.onImpact(e));
    ctx.events.on('weapon:fire', (e) => this.onWeaponFire(e));
    ctx.events.on('bullet:tracer', (e) => this.tracer(e.from, e.to, e.speed));
    ctx.events.on('explosion', (e) => this.explosion(e));
    ctx.events.on('player:land', (e) => this.onLand(e));
    ctx.events.on('player:footstep', (e) => this.onFootstep(e));
    ctx.events.on('actor:death', (e) => this.onActorDeath(e));
  }

  /* ================================================================== */
  /* レシピが呼ぶ API (契約 — シグネチャを変えないこと)                  */
  /* ================================================================== */

  /**
   * emit 系は **バインド済みのインスタンスプロパティ**として持つ。
   *
   * ## なぜプロトタイプメソッドではいけないか (実際に踏んだ)
   *
   * muzzle.js のレシピはこう書かれている:
   *
   *     const emitAdd = view ? fx.emitViewAdd : fx.emitAdd;
   *     ...
   *     emitAdd(s);
   *
   * **メソッド参照を変数に取り出して裸で呼ぶ**ので、プロトタイプメソッドだと
   * `this` が undefined になり「Cannot read properties of undefined (reading
   * 'disabled')」で落ちる。レシピ側を直すのではなく、こちらがバインドして渡すのが
   * 正しい (レシピは契約の消費者であって、契約に合わせるのは提供側の責務)。
   *
   * `emitView*` は Three 版の viewScene 相当。この移植は 1 カメラ構成でビュー空間が
   * 存在しないので world 層に流すエイリアス。**存在しないとレシピが undefined を
   * 呼んで落ちる**ので必ず残すこと。
   */
  _bindEmitters() {
    this.emitAdd = (s) => {
      if (this.disabled || !this.particlesEnabled) return;
      this.add.emit(s, this._now);
    };
    this.emitLit = (s) => {
      if (this.disabled || !this.particlesEnabled) return;
      this.lit.emit(s, this._now);
    };
    this.emitViewAdd = this.emitAdd;
    this.emitViewLit = this.emitLit;
  }

  /**
   * デカールを貼る。
   *
   * `opts.tile` はデカールアトラスの ID (fx/atlas.js の D)。
   * `min`/`max` が来たら乱数でサイズを決める (レシピがこの形で呼ぶ)。
   */
  addDecal(point, normal, opts = {}) {
    if (this.disabled) return;
    const size =
      opts.size ?? (opts.min !== undefined ? this.rng.range(opts.min, opts.max ?? opts.min) : 0.06);
    this.decals.add(point, normal, {
      tile: opts.tile ?? D.HOLE_CONCRETE,
      size,
      life: opts.life ?? 45,
      alpha: opts.alpha ?? 1,
      rot: opts.rot ?? this.rng.float() * Math.PI * 2,
      r: opts.r ?? 1,
      g: opts.g ?? 1,
      b: opts.b ?? 1,
    }, this._now);
  }

  /**
   * ふわりと広がる霞。着弾の土煙や爆風の煙に使う。
   *
   * `grow` は寿命の終わりに何倍まで膨らむか。煙は必ず膨らませること — 大きさが
   * 変わらない煙は「板が浮いている」ようにしか見えない。
   */
  haze(x, y, z, radius, grow, life, strength, tile = P.SMOKE_A) {
    if (this.disabled) return;
    const s = resetSpawn();
    s.x = x; s.y = y; s.z = z;
    s.vx = this.rng.signed() * 0.12;
    s.vy = 0.18 + this.rng.float() * 0.22;
    s.vz = this.rng.signed() * 0.12;
    s.tile = tile;
    s.size0 = radius;
    s.size1 = radius * grow;
    s.sizeCurve = 0.55;
    s.life = life;
    s.drag = 1.1;
    s.gravity = 0.35;
    s.rot = this.rng.float() * Math.PI * 2;
    s.spin = this.rng.signed() * 0.35;
    s.r0 = s.g0 = s.b0 = 1;
    s.i0 = 1;
    s.r1 = s.g1 = s.b1 = 1;
    s.i1 = 1;
    s.alpha = strength;
    s.alphaCurve = 1.4;
    s.soft = 0.5;
    s.turb = 0.12;
    s.turbFreq = 0.7;
    s.seed = this.rng.float();
    this.emitLit(s);
  }

  /** 地面を這うように広がるリング状の煙。爆発の根元に使う。 */
  hazeRing(x, y, z, radius, grow, life, strength) {
    if (this.disabled) return;
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rng.signed() * 0.3;
      const s = resetSpawn();
      s.x = x + Math.cos(a) * radius * 0.6;
      s.y = y + 0.1;
      s.z = z + Math.sin(a) * radius * 0.6;
      s.vx = Math.cos(a) * radius * 1.6;
      s.vy = 0.25;
      s.vz = Math.sin(a) * radius * 1.6;
      s.tile = P.SMOKE_B;
      s.size0 = radius * 0.5;
      s.size1 = radius * grow;
      s.life = life * this.rng.range(0.8, 1.2);
      s.drag = 2.2;
      s.gravity = 0.2;
      s.rot = this.rng.float() * Math.PI * 2;
      s.spin = this.rng.signed() * 0.5;
      s.alpha = strength;
      s.alphaCurve = 1.6;
      s.soft = 0.6;
      s.seed = this.rng.float();
      this.emitLit(s);
    }
  }

  /** 立ち上る煙柱。破壊された車両や燃え跡に使う。 */
  addSmokeColumn(x, y, z, o = {}) {
    if (this.disabled) return;
    const n = o.count ?? 5;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      s.x = x + this.rng.signed() * 0.2;
      s.y = y + i * 0.15;
      s.z = z + this.rng.signed() * 0.2;
      s.vy = (o.rise ?? 1.6) * this.rng.range(0.8, 1.2);
      s.vx = this.rng.signed() * 0.2;
      s.vz = this.rng.signed() * 0.2;
      s.tile = P.SMOKE_A;
      s.size0 = o.size ?? 0.35;
      s.size1 = (o.size ?? 0.35) * (o.grow ?? 3.2);
      s.life = o.life ?? 3.2;
      s.drag = 0.5;
      s.gravity = 0.5;
      s.delay = i * 0.08;
      s.rot = this.rng.float() * Math.PI * 2;
      s.spin = this.rng.signed() * 0.25;
      s.r0 = s.g0 = s.b0 = o.dark ?? 0.35;
      s.r1 = s.g1 = s.b1 = 0.75;
      s.alpha = o.alpha ?? 0.7;
      s.alphaCurve = 1.5;
      s.soft = 0.7;
      s.turb = 0.3;
      s.turbFreq = 0.5;
      s.seed = this.rng.float();
      this.emitLit(s);
    }
  }

  /**
   * 被弾体の背後に飛ぶ血糊。
   *
   * 入射方向の延長線上で最初に当たる面に貼る。壁際で撃たれたときに背後の壁が
   * 汚れる、という表現。
   */
  bloodSpatterBehind(point, incident) {
    if (this.disabled || !this.physics) return;
    const h = this.physics.raycast(point, incident, 3.2, this.physics.MASK.WORLD);
    if (!h.hit) return;
    for (let i = 0; i < 2; i++) {
      this.addDecal(h.point, h.normal, {
        tile: this.rng.float() < 0.5 ? D.BLOOD_A : D.BLOOD_B,
        min: 0.16,
        max: 0.34,
        life: 60,
        alpha: 0.8,
        r: 0.42,
        g: 0.05,
        b: 0.04,
      });
    }
  }

  /** 焦げ跡。爆発の中心に貼る。 */
  scorch(x, y, z, radius) {
    if (this.disabled || !this.physics) return;
    this._v.set(0, -1, 0);
    const from = { x, y: y + 0.5, z };
    const h = this.physics.raycast(from, this._v, 3, this.physics.MASK.WORLD);
    if (!h.hit) return;
    this.addDecal(h.point, h.normal, {
      tile: D.SCORCH,
      size: radius,
      life: 90,
      alpha: 0.85,
      r: 0.1,
      g: 0.09,
      b: 0.08,
    });
  }

  /** ワールド空間の太陽方向 (地上 → 太陽)。 */
  sunWorld() {
    return this._sun;
  }

  /**
   * 一人称視点を照らす閃光。
   *
   * ビューモデル専用のライトは **作らない**。core/engine.js の RENDER_GROUP の
   * コメントにある通り、ビューモデルは world と同一の照明で焼かれることが設計の
   * 目的であり、専用ライトを足すと README に記録された「20 倍 irradiance」事故を
   * 再導入することになる。ここではプールの PointLight を銃口位置に置くだけ。
   */
  viewFlash(x, y, z, r, g, b, strength = 1) {
    this.flashLight(x, y, z, r, g, b, strength * 6, 0.055);
  }

  /* ================================================================== */
  /* 動的光源                                                           */
  /* ================================================================== */

  /** プールから 1 灯借りて、短時間光らせる。 */
  flashLight(x, y, z, r, g, b, intensity, duration, decay = 6, range = 8) {
    const e = this._lights[this._lightCursor];
    this._lightCursor = (this._lightCursor + 1) % this._lights.length;
    e.light.position.set(x, y, z);
    e.light.diffuse.set(r, g, b);
    e.light.range = range;
    e.peak = intensity;
    e.decay = decay;
    e.start = this._now;
    e.until = this._now + duration;
    return e;
  }

  _updateLights(now) {
    for (const e of this._lights) {
      if (now >= e.until) {
        e.light.intensity = 0;
        continue;
      }
      const t = (now - e.start) / Math.max(1e-4, e.until - e.start);
      // 立ち上がりは瞬時、減衰は指数。火薬の燃焼はこの形。
      // decay はレシピが指定する。火薬の燃焼は指数減衰。
      e.light.intensity = e.peak * Math.exp(-t * (e.decay ?? 6));
    }
  }

  /* ================================================================== */
  /* イベントハンドラ                                                    */
  /* ================================================================== */

  onImpact(e) {
    if (this.disabled) return;
    const inc = e.incident ?? this._defaultIncident(e);
    spawnImpact(this, e.point, e.normal, inc, e.surface, e.damage / 30);
  }

  _defaultIncident(e) {
    // 入射方向が無い場合は法線の逆で代用する。裏抜けの向きが多少ずれるだけ。
    this._v.set(-e.normal.x, -e.normal.y, -e.normal.z);
    return this._v;
  }

  onWeaponFire(e) {
    if (this.disabled) return;
    /**
     * レシピは `o.position` / `o.direction` を **オブジェクトとして**受け取る。
     * 分解した x/dx の形で渡すと `p.x` が undefined になって落ちる (実際に踏んだ)。
     */
    this.muzzleFlash({
      position: e.origin,
      direction: e.dir,
      weapon: e.weapon,
      seed: e.seed,
      // 1 カメラ構成なので view 空間は無い。レシピ側は view=false として扱う。
      view: false,
    });
  }

  muzzleFlash(o) {
    if (this.disabled) return;
    muzzleFlashRecipe(this, o);
  }

  tracer(from, to, speed) {
    if (this.disabled) return;
    spawnTracer(this, from, to, speed);
  }

  explosion(e) {
    if (this.disabled) return;
    explodeRecipe(this, e);
  }

  /** 薬莢。physics の剛体として飛ばす。 */
  spawnShell(position, velocity) {
    if (this.disabled) return;
    this.physics.spawnDebris(position, velocity, {
      size: 0.005,
      mass: 0.012,
      surface: 'metal',
      lifetime: 4,
    });
  }

  onLand(e) {
    if (this.disabled || e.velocity < 3) return;
    const n = Math.min(10, Math.round(e.velocity));
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      const a = this.rng.float() * Math.PI * 2;
      const r = this.rng.float() * 0.3;
      s.x = e.position.x + Math.cos(a) * r;
      s.y = e.position.y + 0.03;
      s.z = e.position.z + Math.sin(a) * r;
      s.vx = Math.cos(a) * 1.2;
      s.vy = 0.4;
      s.vz = Math.sin(a) * 1.2;
      s.tile = P.DUST;
      s.size0 = 0.06;
      s.size1 = 0.2;
      s.life = 0.7;
      s.drag = 3;
      s.gravity = -1.2;
      s.alpha = 0.3;
      s.seed = this.rng.float();
      this.emitLit(s);
    }
  }

  onFootstep(e) {
    if (this.disabled || !e.running) return;
    const s = resetSpawn();
    s.x = e.position.x;
    s.y = e.position.y + 0.02;
    s.z = e.position.z;
    s.vy = 0.25;
    s.tile = P.DUST;
    s.size0 = 0.04;
    s.size1 = 0.14;
    s.life = 0.5;
    s.drag = 3.5;
    s.alpha = 0.18;
    s.seed = this.rng.float();
    this.emitLit(s);
  }

  onActorDeath(e) {
    if (this.disabled) return;
    // 倒れた場所に土煙。
    this.haze(e.point.x, e.point.y + 0.2, e.point.z, 0.3, 2.2, 1.1, 0.25, P.DUST);
  }

  /* ================================================================== */
  /* フレーム                                                            */
  /* ================================================================== */

  update(dt, ctx) {
    /**
     * **ゲーム内経過秒を使う**。performance.now() を使うと、キャプチャで boot 時間が
     * 変わるだけで粒子の位相が変わり bit-identical が壊れる (README の
     * 「performance.now() でアニメーションしていたサブシステム」と同じ罠)。
     */
    this._now = ctx.time.elapsed;
    if (this.disabled) return;
    this._updateLights(this._now);
  }

  lateUpdate(dt, ctx) {
    if (this.disabled) return;
    this._syncLighting(ctx);
    this.add.flush(this._now);
    this.lit.flush(this._now);
    this.decals.flush(this._now);
  }

  /**
   * 粒子とデカールのライティングを sky に合わせる。
   *
   * 粒子は前方描画で PBR パイプラインの外に居るため、放っておくと **周囲と露出が
   * 合わない**。sky が持つ太陽色・環境色・フォグをそのまま渡して合わせる。
   */
  _syncLighting(ctx) {
    const sky = ctx.peek('sky');
    if (!sky?.sunDir) return;
    this._sun.copyFrom(sky.sunDir);

    // 粒子シェーダはビュー空間で解くので、太陽方向と上方向を変換しておく。
    const view = ctx.scene.getViewMatrix();
    Vector3.TransformNormalToRef(this._sun, view, this._sunView);
    this._upView.set(0, 1, 0);
    Vector3.TransformNormalToRef(this._upView, view, this._upView);

    const sc = sky.sun.diffuse;
    const si = sky.sun.intensity;
    this._sunCol.set(sc.r * si, sc.g * si, sc.b * si);

    const amb = sky.ambient;
    this._ambTop.set(
      amb.diffuse.r * amb.intensity,
      amb.diffuse.g * amb.intensity,
      amb.diffuse.b * amb.intensity
    );
    this._ambBot.set(
      amb.groundColor.r * amb.intensity,
      amb.groundColor.g * amb.intensity,
      amb.groundColor.b * amb.intensity
    );

    const fc = ctx.scene.fogColor;
    this._fog.set(fc.r, fc.g, fc.b, ctx.scene.fogDensity);

    this.lit.setLighting(this._sunView, this._sunCol, this._ambTop, this._ambBot, this._upView, this._fog);
    this.add.setLighting(this._sunView, this._sunCol, this._ambTop, this._ambBot, this._upView, this._fog);

    this._amb.set(this._ambTop.x * 0.6, this._ambTop.y * 0.6, this._ambTop.z * 0.6);
    this.decals.setLighting(this._sun, this._sunCol, this._amb);
  }

  /* ================================================================== */
  /* デバッグ (キャプチャのショットが呼ぶ)                               */
  /* ================================================================== */

  /**
   * 壁への着弾を連続で演出する。`impacts` ショットが使う。
   *
   * 'none' で停止する。ショットは 1 セッションで連続適用されるので、**止められる
   * ことが必須** (止められないと次のショットの背後で撃ち続ける)。
   */
  debugBurst(kind = 'wall') {
    this._burst = kind === 'none' ? null : { kind, next: 0, i: 0 };
    if (kind === 'none') return;
    if (this.disabled) return;
    // 即座に数発分を撒く。settle フレームの間に絵が出来上がるように。
    for (let i = 0; i < 8; i++) this._burstOne(i);
  }

  _burstOne(i) {
    if (!this.physics) return;
    const cam = this.ctx.camera;
    const fwd = cam.getDirection(new Vector3(0, 0, -1));
    const origin = cam.globalPosition;
    // 少しばらけさせて壁に散らす。
    const d = new Vector3(
      fwd.x + this.rng.signed() * 0.06,
      fwd.y + this.rng.signed() * 0.04,
      fwd.z + this.rng.signed() * 0.06
    );
    const h = this.physics.raycast(origin, d, 30, this.physics.MASK.BULLET);
    if (!h.hit) return;
    this._v.set(d.x, d.y, d.z);
    spawnImpact(this, h.point, h.normal, this._v, h.surface, 1);
  }

  dispose() {
    this.add?.dispose();
    this.lit?.dispose();
    this.decals?.dispose();
    for (const e of this._lights) e.light.dispose();
    this._lights.length = 0;
  }
}

export { P, D, ATLAS_COLS, resetSpawn, SP, blackbody, C };
