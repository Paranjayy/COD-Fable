import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';

/**
 * The weapon material set — Babylon 版。
 *
 * Three 版 (1,215 行) は「viewmodel 専用ライトリグが world の ~20 倍の irradiance を
 * 出す」壊れた前提の上で、全 albedo を物理値の 1/10 に潰して辻褄を合わせていた。
 * Babylon 版は 1 カメラ + renderingGroupId 構成 (core/engine.js RENDER_GROUP 参照) で
 * **武器は world と同じ IBL・同じ露出で焼かれる**ため、その補正は全部捨てる。
 *
 * ## ルール (README の品質バー)
 *
 *  - albedo は物理レンジ 0.02〜0.9 (linear)。露出で辻褄を合わせない。
 *  - metals are 0 or 1 — 金属はライブラリの metal_brushed (metallic=1) 系の
 *    クローンで、tint は F0 として働く。
 *
 * ## ライブラリとの関係
 *
 * `ctx.get('materials')` の PBRMaterial を **clone してから** tint / roughness を
 * いじる。variant() を使わないのは 2 つ理由がある:
 *  1. variant は tune(uvScale) が共有テクスチャの uScale を直接書くため、武器の
 *     都合で world の壁のタイルまで変わる事故が起きうる (clone ならテクスチャは
 *     共有したままマテリアル設定だけ独立する)。
 *  2. 武器は backFaceCulling を切る必要がある (geometry.js は GL/Three 巻き順で
 *     頂点を作るため) — これも共有インスタンスには適用できない。
 *
 * albedoColor はテクスチャに **乗算** される (Babylon PBR の仕様)。ライブラリの
 * ベース (rubber ≈ 0.026 linear 等) からの倍率として tint を選んである。
 */

/**
 * 肩付けした武器が実際に見る空の割合。射手の頭・胸・腕が半球の大部分を遮る。
 * world の environmentIntensity は 1.0 (sky が設定) なので、武器側マテリアルの
 * environmentIntensity で相対的に落とす。
 */
export const ENV_OCCLUSION = 0.55;

/**
 * key -> { base: ライブラリ名, tint: 乗算 Color3, roughness/metallic: 係数 }
 * roughness はライブラリの ORM テクスチャ G チャネルに掛かる係数 (glTF 流儀)。
 */
export const WEAPON_MATERIALS = {
  /** Hard-anodised aluminium — 受け筒・レール・ハンドガードシャシー。冷たい暗灰。 */
  alu: { base: 'rubber', tint: [1.35, 1.45, 1.75], roughness: 0.85 },
  /** 同じ陽極酸化でビーズブラスト仕上げ (光学サイトのボディ)。一段暗く滑らか。 */
  alu_fine: { base: 'rubber', tint: [1.0, 1.06, 1.28], roughness: 0.7 },
  /** Parkerised / phosphated steel — 銃身・ガスブロック。metallic=1 なので tint は F0。 */
  steel: { base: 'metal_brushed', tint: [0.38, 0.36, 0.33], roughness: 1.8 },
  /**
   * Sooted steel — マズルデバイスとガスブロック周り。カーボンは金属ではなく
   * 「リン酸被膜の上に乗った誘電体の粉」— Three 版で測定済みの知見 (金属のままでは
   * どんな F0/roughness でも GGX ローブが白飛びする)。rubber ベースの暗い誘電体。
   */
  steel_soot: { base: 'rubber', tint: [0.72, 0.66, 0.6], roughness: 1.15 },
  /** Bare, oiled steel — ボルトキャリア・チャーハン・トリガー。一番光る金属。 */
  steel_bright: { base: 'metal_brushed', tint: [0.85, 0.85, 0.9], roughness: 1.25 },
  /** Black nitrided steel — ピストルスライド。暗いがトップエッジにハイライトが走る。 */
  steel_black: { base: 'metal_brushed', tint: [0.42, 0.43, 0.46], roughness: 1.5 },
  /** Glass-filled polymer — マガジン・ストック・グリップ・ハンドガードパネル。
   *  alu より 15% 暗く、逆方向 (暖色) に振る — 1080p で素材差を読ませる唯一の手。 */
  polymer: { base: 'rubber', tint: [1.28, 1.18, 1.0], roughness: 1.1 },
  /** Soft rubber — グリップのオーバーモールド・バットパッド・アイカップ。最暗。 */
  rubber: { base: 'rubber', tint: [0.8, 0.75, 0.7], roughness: 1.25 },
  /** Cartridge brass — F0 ≈ (0.78, 0.55, 0.25)。 */
  brass: { base: 'metal_brushed', tint: [2.4, 1.7, 0.75], roughness: 1.1 },
  /** Copper jacket。 */
  copper: { base: 'metal_brushed', tint: [2.4, 1.35, 0.95], roughness: 1.15 },

  /* ---- hands (hands.js が使う 4 面) ------------------------------------ */
  /** Glove shell — 銃と同値・同色相だと「ロボット装甲」に見える (Three 版の実測)。
   *  暖色 1.5:1 red-over-blue に振り、受け筒より 1/3 段明るく。 */
  glove: { base: 'fabric', tint: [0.62, 0.5, 0.4], roughness: 1.2 },
  /** Reinforced palm / knuckle pads — シェルより半段暗い TPR。 */
  glove_pad: { base: 'rubber', tint: [1.0, 0.82, 0.68], roughness: 1.3 },
  /** Stitched seam — シェルの 1.85 倍。1-3 px 幅で AA を生き延びるための分離。 */
  glove_seam: { base: 'fabric', tint: [1.1, 0.9, 0.72], roughness: 1.15 },
  /** Combat-shirt sleeve — コヨーテリップストップ。リグで一番暖かい面。 */
  sleeve: { base: 'fabric', tint: [1.05, 0.98, 0.82], roughness: 1.2 },
};

/**
 * Resolves and caches the weapon materials, plus the couple of custom
 * materials that have no library equivalent (optic glass, reticle, cavities).
 * Owned materials/textures はここで dispose する。
 */
export class WeaponMaterials {
  constructor(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.lib = ctx.peek('materials');
    this.cache = new Map();
    this.owned = [];
    this.ownedTex = [];
    this._rimTex = null;
  }

  /** @returns {import('@babylonjs/core/Materials/material.js').Material} */
  get(key) {
    if (key === 'cavity') return this.cavity();
    if (key === 'optic_tube') return this.opticTube();
    if (key === 'glass') return this.glass();
    if (key === 'lens_ring') return this.lensRing();
    if (key === 'lens_vig') return this.lensVignette();
    let m = this.cache.get(key);
    if (m) return m;
    const def = WEAPON_MATERIALS[key];
    if (def && this.lib) {
      m = this.lib.get(def.base).clone(`wp_${key}`);
      /**
       * albedoColor はテクスチャへの乗算係数。degraded (WebGL2) パスでは
       * ライブラリが無地マテリアルを配るので、乗算するとベース色が二重に
       * 変わるが、degraded は元々「絵は平坦・動作優先」の縮退なので許容。
       */
      const base = m.albedoColor ?? new Color3(1, 1, 1);
      m.albedoColor = new Color3(base.r * def.tint[0], base.g * def.tint[1], base.b * def.tint[2]);
      if (def.roughness !== undefined) m.roughness = def.roughness;
      if (def.metallic !== undefined) m.metallic = def.metallic;
      /**
       * geometry.js は GL/Three 流の CCW 巻き順で頂点を作る。Babylon 側の既定
       * sideOrientation と合わない可能性があるため、武器面は両面描画にして
       * 巻き順を無害化する (法線は解析的に外向きなので陰影は正しい)。
       */
      m.backFaceCulling = false;
      m.environmentIntensity = ENV_OCCLUSION;
    } else {
      m = this._fallback(key);
    }
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /** materials サブシステムが無い場合の無地フォールバック。 */
  _fallback(key) {
    const metal = key === 'steel' || key === 'steel_bright' || key === 'steel_black' || key === 'brass' || key === 'copper';
    const m = new PBRMaterial(`wp_fb_${key}`, this.scene);
    m.albedoColor = key === 'brass' ? new Color3(0.7, 0.5, 0.18) : metal ? new Color3(0.23, 0.24, 0.26) : new Color3(0.16, 0.16, 0.17);
    m.roughness = metal ? 0.4 : 0.75;
    m.metallic = metal ? 1 : 0;
    m.backFaceCulling = false;
    return m;
  }

  /**
   * 光学サイト内壁 = ライトトラップ。真っ黒 (cavity) ではなくグラデーションの
   * 読める黒 (0.02 linear / roughness 0.9)。Three 版の ADS 実測から持ち越した結論。
   */
  opticTube() {
    const key = 'optic_tube';
    let m = this.cache.get(key);
    if (m) return m;
    m = new PBRMaterial('wp_optic_tube', this.scene);
    m.albedoColor = new Color3(0.02, 0.022, 0.024);
    m.roughness = 0.9;
    m.metallic = 0;
    m.environmentIntensity = 0.3;
    m.backFaceCulling = false;
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /** 対物リム内側の明るいアーク (レンズ反射)。加算・無ライト。 */
  lensRing(intensity = 0.14) {
    const key = `lensRing:${intensity}`;
    let m = this.cache.get(key);
    if (m) return m;
    m = this._unlit('wp_lens_ring', new Color3(0.62 * intensity, 0.77 * intensity, 0.85 * intensity), 0.5, true);
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /**
   * Optic glass — AR コートの残留反射だけを持つ薄い誘電体。
   * Three 版の iridescence/sheen による色相スイングは Babylon の PBR にそのまま
   * 対応物が無いので、弱い青緑の反射 + 高い環境反射で近似する (縮小移植)。
   */
  glass(tint = 0x3b6e8c) {
    const key = `glass:${tint}`;
    let m = this.cache.get(key);
    if (m) return m;
    m = new PBRMaterial('wp_optic_glass', this.scene);
    m.albedoColor = new Color3(0.02, 0.035, 0.045);
    m.alpha = 0.12; // 吸収は低く — 上げるとスモークレンズになり世界が濁る
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    m.roughness = 0.05;
    m.metallic = 0;
    m.environmentIntensity = 1.4;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    m.alphaIndex = 5;
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /** 半径方向アルファランプ (縁 1 → 中心 0)。ビネットと視野絞りに使う。 */
  _rimRamp() {
    if (this._rimTex) return this._rimTex;
    const N = 64;
    const data = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N - 0.5;
        const v = (y + 0.5) / N - 0.5;
        const r = Math.min(1, Math.hypot(u, v) * 2);
        const t = Math.max(0, (r - 0.8) / 0.2);
        const a = t * t * (3 - 2 * t);
        const i = (y * N + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.round(a * 255);
      }
    }
    const t = RawTexture.CreateRGBATexture(
      data, N, N, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE
    );
    t.wrapU = Texture.CLAMP_ADDRESSMODE;
    t.wrapV = Texture.CLAMP_ADDRESSMODE;
    this._rimTex = t;
    this.ownedTex.push(t);
    return t;
  }

  /** 接眼レンズ直後の暗いビネット板。中心は透明、縁で `strength`。 */
  lensVignette(strength = 0.34) {
    const key = `vignette:${strength}`;
    let m = this.cache.get(key);
    if (m) return m;
    m = this._unlit('wp_lens_vig', new Color3(0.005, 0.007, 0.01), strength, false);
    m.opacityTexture = this._rimRamp();
    m.alphaIndex = 8;
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /** レティクルの暗い縁取り。加算では背景より暗く描けないので通常ブレンド。 */
  reticleOutline(opacity = 0.8) {
    const key = `reticleOutline:${opacity}`;
    let m = this.cache.get(key);
    if (m) return m;
    m = this._unlit('wp_reticle_outline', new Color3(0.08, 0.02, 0.04), opacity, false);
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /** Additive, unlit, depth-tested reticle。 */
  reticle(color = 0xff2a12, intensity = 1) {
    const key = `reticle:${color}:${intensity}`;
    let m = this.cache.get(key);
    if (m) return m;
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    m = this._unlit(`wp_reticle_${color.toString(16)}`, new Color3(r * intensity, g * intensity, b * intensity), 1, true);
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /**
   * 無ライトの板ポリ素材。PBRMaterial の unlit を使う — StandardMaterial を
   * 持ち込まないのは、このプロジェクトで WGSL 検証済みなのが PBR 系だけのため。
   */
  _unlit(name, color, alpha, additive) {
    const m = new PBRMaterial(name, this.scene);
    m.unlit = true;
    m.albedoColor = color;
    m.alpha = alpha;
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    if (additive) m.alphaMode = Constants.ALPHA_ADD;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    return m;
  }

  /** Matte black interior — ボア・レンズハウジング・排莢ポートの空洞。 */
  cavity() {
    const key = 'cavity';
    let m = this.cache.get(key);
    if (m) return m;
    m = new PBRMaterial('wp_cavity', this.scene);
    m.albedoColor = new Color3(0.02, 0.021, 0.023);
    m.roughness = 1;
    m.metallic = 0;
    m.environmentIntensity = 0.15;
    m.backFaceCulling = false;
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  dispose() {
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    for (const t of this.ownedTex) t.dispose();
    this.ownedTex.length = 0;
    this._rimTex = null;
    this.cache.clear();
  }
}

export const MATERIAL_KEYS = Object.keys(WEAPON_MATERIALS);
