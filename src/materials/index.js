import { ProceduralTexture } from '@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector2, Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';

import { WGSL_SURFACE } from './wgsl/surface.js';
import { WGSL_NORMAL, WGSL_ORM } from './wgsl/derive.js';
import { LIBRARY, SURFACE_KEYS, hexToLinear } from './library.js';

/**
 * MATERIALS — GPU テクスチャ鍛冶場。
 *
 * 19 種の手続きサーフェスを起動時に GPU 上で焼き、PBRMaterial として配る。
 * 画像アセットは 1 枚も使わない (README の「There are no art assets」)。
 *
 * ## 生成パイプライン (1 サーフェスあたり 3 パス)
 *
 *   1. surface.wgsl → albedo(rgb) + height(a)      … RGBA8 1 枚
 *   2. derive.wgsl(NORMAL) → 接空間法線             … height を Sobel
 *   3. derive.wgsl(ORM)    → R=AO, G=rough, B=metal … height から派生
 *
 * albedo と height を 1 パスで出すのは、両者が同じ fbm/voronoi 評価を共有する
 * ため。分けると同じノイズを 2 回引くことになり、19 サーフェス分では無視できない。
 *
 * ## WebGPU 必須である理由と、WebGL2 での挙動
 *
 * シェーダは **WGSL のみ**で書いてある。GLSL と両方を保守すると同じノイズ実装が
 * 2 箇所に分裂し、片方だけ直る事故が起きる (Three 版の surfaces-*.glsl 4 分割が
 * まさにそれだった)。DRY を優先して WGSL に一本化している。
 *
 * したがって WebGL2 にフォールバックした場合、鍛冶場は動かない。その場合は
 * **ライブラリの tint と orm だけを使った無地の PBRMaterial** を配る。ゲームは
 * 起動し操作もできるが絵は平坦になる。黙って劣化させないよう `degraded` を
 * true にして console.warn を出す。
 */
export class MaterialSystem {
  static id = 'materials';
  static deps = [];

  constructor(opts = {}) {
    /** 生成解像度の倍率。低品質プリセットや素早い反復のために落とせる。 */
    this.sizeScale = opts.sizeScale ?? 1;
    /** name -> PBRMaterial */
    this.materials = new Map();
    /** name -> { albedo, normal, orm } */
    this.textures = new Map();
    /** WebGL2 フォールバックで鍛冶場が動かなかったか。 */
    this.degraded = false;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.degraded = ctx.backend !== 'webgpu';

    if (this.degraded) {
      console.warn(
        '[materials] WebGPU が使えないため手続きテクスチャ生成を無効化しました。' +
          '無地の PBR マテリアルで代替します (ゲームは動作しますが絵は平坦になります)。'
      );
    }

    const t0 = performance.now();
    for (const name of SURFACE_KEYS) await this._build(name);
    console.info(
      `[materials] ${SURFACE_KEYS.length} surfaces in ${(performance.now() - t0).toFixed(0)}ms` +
        (this.degraded ? ' (degraded: flat)' : '')
    );
  }

  /* ================================================================== */
  /* Bake                                                               */
  /* ================================================================== */

  async _build(name) {
    const def = LIBRARY[name];
    const mat = new PBRMaterial(`mat_${name}`, this.scene);
    mat.metadata = { owSurface: def.surface, owLibrary: name };

    const tint = hexToLinear(def.colors.tint);
    const [roughBase, , aoStrength, metallic] = def.orm;

    if (this.degraded) {
      // 無地フォールバック。値域は README の品質バー (albedo 0.02-0.9) に従う。
      mat.albedoColor = new Color3(tint[0], tint[1], tint[2]);
      mat.roughness = roughBase;
      mat.metallic = metallic;
      this.materials.set(name, mat);
      return mat;
    }

    const size = Math.max(64, Math.round(def.bake.size * this.sizeScale));
    const tex = await this._bakeSet(name, def, size);
    this.textures.set(name, tex);

    mat.albedoTexture = tex.albedo;
    mat.bumpTexture = tex.normal;
    /**
     * ORM を 1 枚の metallicTexture として渡す。R/G/B の割り当ては
     * derive.wgsl(ORM) と厳密に対応していなければならない — ここがズレると
     * 「なぜか全部つるつる」「なぜか全部金属」になり、しかも絵から原因を辿りにくい。
     */
    mat.metallicTexture = tex.orm;
    mat.useAmbientOcclusionFromMetallicTextureRed = true;
    mat.useRoughnessFromMetallicTextureGreen = true;
    mat.useMetallnessFromMetallicTextureBlue = true;
    mat.useRoughnessFromMetallicTextureAlpha = false;
    mat.ambientTextureStrength = aoStrength;

    // 法線は生成時に OpenGL 規約 (Y+ 上) で書き出しているので反転しない。
    mat.invertNormalMapX = false;
    mat.invertNormalMapY = false;

    this.materials.set(name, mat);
    return mat;
  }

  /**
   * 3 パスを焼いて { albedo, normal, orm } を返す。
   *
   * **各パスは必ず `bake()` を通すこと。** Babylon の ProceduralTexture は
   * WGSL の頂点シェーダ (`ShadersWGSL/procedural.vertex.js`) を **動的 import** で
   * 遅延ロードするため、コンストラクタ直後に render() を呼ぶと
   * 「Invalid call to enableEffect: the effect property is empty!」で落ちる。
   * さらに 2 パス目以降は 1 パス目の描画結果を読むので、順序も守る必要がある。
   */
  async _bakeSet(name, def, size) {
    const b = def.bake;
    const tile = new Vector2(b.tile, b.tile);

    // --- pass 1: albedo + height -------------------------------------
    const src = this._makePT(`${name}_src`, size, WGSL_SURFACE);
    src.setFloat('kind', def.kind);
    src.setFloat('seedf', b.seed);
    src.setVector2('tile', tile);
    src.setVector3('tint', vec3(hexToLinear(def.colors.tint)));
    src.setVector3('tint2', vec3(hexToLinear(def.colors.tint2)));
    src.setVector3('grime', vec3(hexToLinear(def.colors.grime)));
    src.setVector4('pa', vec4(b.pa ?? [0, 0, 0, 0]));
    src.setVector4('pb', vec4(b.pb ?? [0, 0, 0, 0]));
    src.setVector4('weather', vec4(def.weather));
    await bake(src);

    // --- pass 2: normal ----------------------------------------------
    /**
     * relief(m) を「テクセル間の勾配」に変換する。
     *
     *   metresPerTexel = world / size
     *   slope          = relief / metresPerTexel = relief * size / world
     *
     * Sobel の出力は無次元の高低差なので、この係数を掛けて初めて実スケールの
     * 法線になる。size を変えても法線強度が変わらないのはこの式のおかげで、ここを
     * 定数にすると sizeScale を落とした瞬間に全サーフェスの陰影が静かに変わる。
     */
    const slope = (b.relief * size) / b.world;
    const normal = this._makePT(`${name}_n`, size, WGSL_NORMAL);
    normal.setTexture('src', src);
    normal.setVector4('texel', new Vector4(1 / size, 1 / size, slope, 0));
    await bake(normal);

    // --- pass 3: ORM --------------------------------------------------
    const orm = this._makePT(`${name}_orm`, size, WGSL_ORM);
    orm.setTexture('src', src);
    orm.setVector4('orm', vec4(def.orm));
    // AO のサンプル半径はテクセル単位。解像度に依らず同じ実寸を見るよう size に比例。
    orm.setVector4('texel', new Vector4(1 / size, 1 / size, Math.max(1, size / 256), 0));
    await bake(orm);

    for (const t of [src, normal, orm]) {
      t.wrapU = Texture.WRAP_ADDRESSMODE;
      t.wrapV = Texture.WRAP_ADDRESSMODE;
      t.anisotropicFilteringLevel = this.ctx.config.q.anisotropy ?? 8;
      /**
       * **すべて線形として解釈させる。**
       *
       * surface.wgsl は albedo を線形で書き出している。Babylon の既定は
       * albedoTexture を sRGB とみなすので、明示的に線形指定しないとガンマ 2.2 ぶん
       * ずれる。ずれた明るさを露出側で辻褄合わせすると、Three 版で武器 albedo を
       * 1/3 に潰して破綻したのと同じ構図に陥る。
       */
      t.gammaSpace = false;
    }

    return { albedo: src, normal, orm };
  }

  _makePT(name, size, source) {
    return new ProceduralTexture(
      name,
      size,
      { fragmentSource: source },
      this.scene,
      {
        shaderLanguage: ShaderLanguage.WGSL,
        // 1 回焼いたら終わり。scene の自動レンダリング対象から外す。
        skipSceneRegistration: true,
        generateMipMaps: true,
        type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
      },
      true
    );
  }

  /* ================================================================== */
  /* Public API                                                         */
  /* ================================================================== */

  /** ライブラリ名からマテリアルを取る。world / weapons / fx が使う。 */
  get(name) {
    const m = this.materials.get(name);
    if (!m) {
      throw new Error(`[materials] unknown surface "${name}" (have: ${SURFACE_KEYS.join(', ')})`);
    }
    return m;
  }

  /**
   * 元のマテリアルを共有したまま一部だけ差し替えた複製を作る。
   *
   * テクスチャは共有されるので VRAM は増えない。色違いの建物や、同じ木材で明度
   * だけ変えたい場合に使う。**毎フレーム呼ばないこと** (シェーダ再コンパイルが走る)。
   */
  variant(name, changes = {}) {
    const key = `${name}:${JSON.stringify(changes)}`;
    let m = this.materials.get(key);
    if (m) return m;
    m = this.get(name).clone(`mat_${key}`);
    this.tune(m, changes);
    this.materials.set(key, m);
    return m;
  }

  /** マテリアルのパラメータを後から調整する。 */
  tune(material, changes = {}) {
    if (changes.tint !== undefined) {
      const c = hexToLinear(changes.tint);
      material.albedoColor = new Color3(c[0], c[1], c[2]);
    }
    if (changes.roughness !== undefined) material.roughness = changes.roughness;
    if (changes.metallic !== undefined) material.metallic = changes.metallic;
    if (changes.uvScale !== undefined) {
      for (const t of [material.albedoTexture, material.bumpTexture, material.metallicTexture]) {
        if (!t) continue;
        t.uScale = changes.uvScale;
        t.vScale = changes.uvScale;
      }
    }
    return material;
  }

  /** 登録済みのライブラリ名一覧。 */
  names() {
    return [...SURFACE_KEYS];
  }

  /** ライブラリ名 → physics/FX の surface 語彙。 */
  surfaceOf(name) {
    return LIBRARY[name]?.surface ?? 'concrete';
  }

  /**
   * メッシュに貼るときの UV スケールを実寸から決める。
   *
   * world (タイルが覆う m) が分かっているので、面の実寸を渡せばテクセル密度を
   * 揃えられる。これをやらないと大きい壁だけテクスチャが引き伸びて見える。
   */
  uvScaleFor(name, widthMetres, heightMetres) {
    const w = LIBRARY[name]?.bake.world ?? 1;
    return new Vector2(widthMetres / w, heightMetres / w);
  }

  dispose() {
    for (const m of this.materials.values()) m.dispose();
    for (const set of this.textures.values()) {
      set.albedo.dispose();
      set.normal.dispose();
      set.orm.dispose();
    }
    this.materials.clear();
    this.textures.clear();
  }
}

/**
 * effect のコンパイル完了を待ってから 1 回だけ描画する。
 *
 * `isReady()` は「初回呼び出しで effect を作り始める」副作用を持つので、ポーリング
 * すること自体がコンパイルのトリガーになる。rAF で回すのは、WebGPU のパイプライン
 * 生成がフレーム境界で進むため。
 *
 * タイムアウトを持たせているのは、WGSL のコンパイルエラー時に isReady() が永遠に
 * false を返して **無言でハングする**ため。黙って止まるより、どのサーフェスで
 * 落ちたかを名前付きで投げた方が原因に辿り着ける。
 */
function bake(pt, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      if (pt.isReady()) {
        pt.render();
        resolve(pt);
        return;
      }
      if (performance.now() - t0 > timeoutMs) {
        reject(new Error(`[materials] "${pt.name}" のシェーダが ${timeoutMs}ms 以内に ready にならなかった (WGSL コンパイルエラーの可能性。ブラウザの console を確認)`));
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function vec3(a) {
  return new Vector3(a[0], a[1], a[2]);
}

function vec4(a) {
  return new Vector4(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
}

export { LIBRARY, SURFACE_KEYS };
