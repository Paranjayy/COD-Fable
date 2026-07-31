import { EffectRenderer, EffectWrapper } from '@babylonjs/core/Materials/effectRenderer.pure.js';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { ILog2 } from '@babylonjs/core/Maths/math.scalar.functions.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
/**
 * **副作用 import。消さないこと。** (ARCHITECTURE.md「副作用 import」の節を参照)
 *
 * `engine.createRenderTargetCubeTexture` は Babylon 9 ではエンジン拡張で、
 * これらを import して初めてメソッドが生える。ReflectionProbe の import 連鎖でも
 * 引き込まれるが、このファイル単体の要求として明示しておく — probe 側の実装が
 * 変わった瞬間に「createRenderTargetCubeTexture is not a function」で落ちる類の
 * 依存を暗黙にしない。WebGL 系と WebGPU 系は**別物で両方必要**。
 */
import '@babylonjs/core/Engines/Extensions/engine.renderTargetCube.js';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.renderTargetCube.js';
/**
 * 副作用 import: Babylon 標準の GGX 事前フィルタシェーダを ShaderStore に登録する。
 *
 * `HDRFiltering` は `extraInitializationsAsync` の動的 import で遅延ロードするが、
 * ここでは静的に両言語を引き込む。理由: (1) boot 時のネットワーク往復を 1 回でも
 * 減らす (事前フィルタは boot のクリティカルパスに居る)、(2) 動的 import の解決
 * 失敗 (ARCHITECTURE.md「Vite の設定」) の可能性を 1 箇所減らす。
 */
import '@babylonjs/core/ShadersWGSL/hdrFiltering.vertex.js';
import '@babylonjs/core/ShadersWGSL/hdrFiltering.fragment.js';
import '@babylonjs/core/Shaders/hdrFiltering.vertex.js';
import '@babylonjs/core/Shaders/hdrFiltering.fragment.js';

/**
 * 空キューブの GGX 事前フィルタ。
 *
 * ## なぜ Babylon 標準の `HDRFiltering` をそのまま使わないのか
 *
 * `HDRFiltering.prefilter(texture)` は **破壊的**: フィルタ済みキューブを新規に
 * 作った後、`_releaseTexture` + `_swapAndDie` で **入力テクスチャの内部テクスチャを
 * 破棄して差し替える** (hdrFiltering.js の `_prefilterInternal`)。入力が
 * ReflectionProbe の RenderTargetTexture だと、プローブの描画先 (RenderTargetWrapper)
 * が死んだ内部テクスチャを指したまま残り、**2 回目以降の焼き直しができなくなる**。
 * 時刻変化のたびに再フィルタするこのゲームでは使えない。
 *
 * 一方でフィルタの中身 — GGX importance sampling で各 mip を roughness に対応
 * させるシェーダ (`hdrFiltering.fragment`) と lod→alphaG の対応 — は Babylon 本体と
 * PBR シェーダ (`pbrBlockReflection` の `getLodFromAlphaG`) の間の検証済みの契約
 * なので、**シェーダと数式はそのまま借用し、「入力と出力を別テクスチャに分けて
 * 何度でも走らせられる」ループだけを自前で持つ**。これがこのクラス。
 *
 * ## 出力テクスチャの寿命
 *
 * 出力キューブ (`texture`) は構築時に 1 度だけ作り、以後は**同じ GPU テクスチャに
 * 描き直す**。`scene.environmentTexture` の参照が安定するので、焼き直しのたびに
 * 全マテリアルが dirty になることはない。
 */
export class SkyGgxPrefilter {
  /**
   * @param {*} engine Babylon engine (WebGPU / WebGL2)
   * @param {*} scene 出力 BaseTexture の所属シーン
   * @param {number} size 出力キューブの一辺 (入力プローブと同じでよい)
   * @param {number} quality GGX importance sampling のサンプル数。
   *   Babylon の既定 (TEXTURE_FILTERING_QUALITY_OFFLINE=4096) はロード時 1 回きり
   *   用の品質。ここは時刻変化のたびに走るので TEXTURE_FILTERING_QUALITY_HIGH=64
   *   を既定にする — 入力が 128px の滑らかな空なのでこれで収束する。
   */
  constructor(engine, scene, size, quality = Constants.TEXTURE_FILTERING_QUALITY_HIGH) {
    this._engine = engine;
    this._size = size;
    /** 出力 mip 数 (128px → 8)。mip N が roughness の高い側。 */
    this._mipCount = ILog2(size) + 1;
    /**
     * lod → alphaG (= roughness^2) の対応パラメータ。**HDRFiltering の既定値と
     * 同じ値にすること** — PBR 側は `vReflectionMicrosurfaceInfos.yz` に載る
     * この 2 つで mip を逆引きするので、フィルタ時と描画時で食い違うと
     * 「roughness に対してボケすぎ/シャープすぎ」の系統誤差になる。
     */
    this._lodGenerationScale = 0.8;
    this._lodGenerationOffset = 0;

    /**
     * 出力キューブ RTT。HDRFiltering._createRenderTarget と同じ設定。
     * HDR を保持するため half float (無ければ float) を選ぶ。
     */
    let textureType = Constants.TEXTURETYPE_UNSIGNED_BYTE;
    if (engine.getCaps().textureHalfFloatRender) textureType = Constants.TEXTURETYPE_HALF_FLOAT;
    else if (engine.getCaps().textureFloatRender) textureType = Constants.TEXTURETYPE_FLOAT;
    this._rt = engine.createRenderTargetCubeTexture(size, {
      format: Constants.TEXTUREFORMAT_RGBA,
      type: textureType,
      createMipMaps: true, // mip チェインを確保する (各 lod に個別レンダリングする)
      generateMipMaps: false, // 自動生成はしない — 各 mip はフィルタ結果で埋める
      generateDepthBuffer: false,
      generateStencilBuffer: false,
      samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      label: 'skyEnvGGXPrefiltered',
    });
    engine.updateTextureWrappingMode(
      this._rt.texture,
      Constants.TEXTURE_CLAMP_ADDRESSMODE,
      Constants.TEXTURE_CLAMP_ADDRESSMODE,
      Constants.TEXTURE_CLAMP_ADDRESSMODE
    );
    // trilinear + 「mip がある」印。これが無いと PBR の textureSampleLevel が
    // mip 0 に張り付き、roughness を変えてもボケ量が変わらない。
    engine.updateTextureSamplingMode(Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, this._rt.texture, true);

    /**
     * `scene.environmentTexture` に渡す顔。内部テクスチャは上の RTT と共有。
     *
     * - `gammaSpace=false`: 中身は線形 HDR 放射輝度。true のままだと PBR が
     *   sRGB→linear 変換を重ね掛けして暗くなる。
     * - `coordinatesMode=INVCUBIC`: ReflectionProbe の RenderTargetTexture cube と
     *   同じ規約 (renderTargetTexture.pure.js が isCube で設定する値)。プローブを
     *   直接 env にしていた旧構成と反射ベクトルの向きを揃える。
     * - `lodGenerationScale/Offset`: フィルタ時と同じ値。PBR はこれを
     *   `vReflectionMicrosurfaceInfos.yz` として読む。
     */
    const tex = new BaseTexture(scene, this._rt.texture);
    tex.name = 'skyEnvGGX';
    tex.gammaSpace = false;
    tex.coordinatesMode = Texture.INVCUBIC_MODE;
    tex.lodGenerationScale = this._lodGenerationScale;
    tex.lodGenerationOffset = this._lodGenerationOffset;
    /** HDRFiltering 互換の印。PBR は読まないがツール/シリアライズが見る。 */
    tex._prefiltered = true;
    this.texture = tex;

    /** フルスクリーン三角形を面ごとに向けて描くレンダラ (HDRFiltering と同じ)。 */
    this._effectRenderer = new EffectRenderer(engine);
    this._effectWrapper = new EffectWrapper({
      engine,
      name: 'skyGgxPrefilter',
      vertexShader: 'hdrFiltering',
      fragmentShader: 'hdrFiltering',
      samplerNames: ['inputTexture'],
      uniformNames: ['vSampleDirections', 'vWeights', 'up', 'right', 'front', 'vFilteringInfo', 'hdrScale', 'alphaG'],
      useShaderStore: true,
      // GAMMA_INPUT は付けない: 入力プローブは linearSpace で焼く (index.js 参照)。
      defines: [`#define NUM_SAMPLES ${quality}u`],
      shaderLanguage: engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    });

    /**
     * 各キューブ面の基底 (up/right/front)。HDRFiltering の directions と同一。
     * 頂点シェーダがフルスクリーン UV をこの基底で方向ベクトルに変換する。
     */
    this._faceBases = [
      [new Vector3(0, 0, -1), new Vector3(0, -1, 0), new Vector3(1, 0, 0)], // +X
      [new Vector3(0, 0, 1), new Vector3(0, -1, 0), new Vector3(-1, 0, 0)], // -X
      [new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 1, 0)], // +Y
      [new Vector3(1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, -1, 0)], // -Y
      [new Vector3(1, 0, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1)], // +Z
      [new Vector3(-1, 0, 0), new Vector3(0, -1, 0), new Vector3(0, 0, -1)], // -Z
    ];
  }

  /** シェーダのコンパイル完了を待つ。init() で 1 度 await すれば以後 run() は同期。 */
  async whenReady() {
    await this._effectWrapper.effect.whenCompiledAsync();
  }

  /**
   * `source` (空プローブのキューブ RTT) を GGX 事前フィルタして出力キューブの
   * 全 face × 全 mip に焼く。
   *
   * @param {*} source ReflectionProbe.cubeTexture。**mip 付きで作られていること**
   *   (フィルタシェーダは solid angle に応じて入力の mip を選ぶ。無いと高 roughness
   *   側がノイズだらけになる)。
   * @returns {boolean} 実行できたら true。effect 未コンパイルなら false (呼び出し側は
   *   dirty フラグを維持して次フレームに再試行する)。
   */
  run(source) {
    const effect = this._effectWrapper.effect;
    if (!effect.isReady() || !source.isReady()) return false;

    const engine = this._engine;
    const inputSize = source.getSize().width;

    // 入力を trilinear で読めるようにしておく (HDRFiltering と同じ保険)。
    const intTexture = source.getInternalTexture();
    if (intTexture) {
      engine.updateTextureSamplingMode(Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, intTexture, true);
    }

    this._effectRenderer.saveStates();
    this._effectRenderer.setViewport();
    this._effectRenderer.applyEffectWrapper(this._effectWrapper);

    effect.setFloat('hdrScale', 1);
    effect.setFloat2('vFilteringInfo', inputSize, ILog2(inputSize) + 1);
    effect.setTexture('inputTexture', source);

    for (let face = 0; face < 6; face++) {
      effect.setVector3('up', this._faceBases[face][0]);
      effect.setVector3('right', this._faceBases[face][1]);
      effect.setVector3('front', this._faceBases[face][2]);
      for (let lod = 0; lod < this._mipCount; lod++) {
        engine.bindFramebuffer(this._rt, face, undefined, undefined, true, lod);
        this._effectRenderer.applyEffectWrapper(this._effectWrapper);
        /**
         * lod → alphaG。HDRFiltering._prefilterInternal と同一の式。
         * lod 0 は alphaG=0 (鏡面そのまま) — シェーダ側も alphaG==0 を
         * 「サンプリングせず素通し」に特別扱いしている。
         */
        let alpha =
          Math.pow(2, (lod - this._lodGenerationOffset) / this._lodGenerationScale) / this._size;
        if (lod === 0) alpha = 0;
        effect.setFloat('alphaG', alpha);
        this._effectRenderer.draw();
      }
    }

    this._effectRenderer.restoreStates();
    engine.restoreDefaultFramebuffer();
    return true;
  }

  dispose() {
    this._effectWrapper.dispose();
    this._effectRenderer.dispose();
    // texture.dispose() は内部テクスチャ (this._rt.texture) も解放する。
    this.texture.dispose();
    this._rt.dispose();
  }
}
