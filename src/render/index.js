import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js';
import { TAARenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline.js';
import { MotionBlurPostProcess } from '@babylonjs/core/PostProcesses/motionBlurPostProcess.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { ClusteredLightContainer } from '@babylonjs/core/Lights/Clustered/clusteredLightContainer.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';

/**
 * RENDER — HDR パイプライン、影、ポストプロセス、露出。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Three.js 版はこのディレクトリに 5,827 行 (CSM / GTAO / TAA / SSR / bloom /
 * motion blur / LUT / composite / prepass / exposure ...) を自前で持っていた。
 * Babylon はこれらをパイプラインとして提供するので、ここの責務は
 * **「どれを、どの設定で有効化するか」を一箇所で決めること**に縮小される。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ## clustered lighting — Three 版で最も高くついたバグの構造的な解
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ARCHITECTURE.md に長い警告が残っている:
 *
 *   > 可視 point light の数が Three のマテリアル program cache key に含まれる。
 *   > ランプ 1 個が減衰半径を跨いで visible=false になるだけで、シーン内の全
 *   > lit マテリアルが再コンパイルされる。実測 +33〜36 programs / 640〜900ms、
 *   > 900 フレーム中 5 回。
 *
 * 回避策として Three 版は「強度 0 のバラストライトを置いて可視数を固定する」
 * という保守しづらい仕掛けを world 側 (`_stabiliseLightCount`) と fx 側の両方に
 * 抱えていた。
 *
 * Babylon 9 の ClusteredLightContainer はライトを 1 つのコンテナに束ね、GPU 上の
 * タイル単位でカリングする。**シェーダから見たライト数は常に一定**なので、この
 * 再コンパイル問題は原理的に発生しない。バラストライトも不要になる。
 *
 * したがって `addLight()` は「ライトを clustered コンテナに入れる」窓口であり、
 * 呼び出し側は減衰やカリングを一切気にしなくてよい。
 */
export class RenderSystem {
  static id = 'render';
  /**
   * sky の後に初期化する。太陽の DirectionalLight が存在しないと CSM を作れない。
   * materials には依存しない (マテリアルはパイプラインに関与しないため)。
   */
  static deps = ['sky'];

  constructor() {
    /** registerPass() で差し込まれた追加ポストプロセス。 */
    this.extraPasses = [];
    /** clustered に入れたライト。 */
    this.lights = [];
    this.screenSize = { width: 1, height: 1 };
    this.frame = 0;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    /** Babylon の描画エンジン。Three 版の `renderer` に相当する。 */
    this.renderer = ctx.engine.babylon;
    this.webgpu = ctx.backend === 'webgpu';
    const q = ctx.config.q;

    this._setupImageProcessing(ctx);
    this._setupShadows(ctx, q);
    this._setupClusteredLights();
    this._setupPipelines(ctx, q);

    ctx.events.on('resize', ({ width, height }) => {
      this.screenSize.width = width;
      this.screenSize.height = height;
    });
  }

  /* ================================================================== */
  /* Image processing / exposure                                        */
  /* ================================================================== */

  _setupImageProcessing(ctx) {
    const ip = this.scene.imageProcessingConfiguration;
    /**
     * ACES トーンマップ。
     *
     * Three 版は AgX を自前実装していた。Babylon の標準は ACES で、ハイライトの
     * 色転びが強い代わりに実装済み。**露出は必ずここ 1 箇所で持つ**こと。マテリアル
     * 側で明るさを盛って辻褄を合わせ始めると、Three 版で武器 albedo を 1/3 に潰した
     * 事故と同じ道に入る。
     */
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = ctx.config.exposure ?? 1.0;
    ip.contrast = 1.0;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 1.4;
    ip.vignetteStretch = 0.4;
    ip.vignetteCameraFov = this.camera.fov;
    this.imageProcessing = ip;
    this._baseExposure = ip.exposure;
  }

  /**
   * 露出補正 (EV)。+1 で 2 倍明るい。
   *
   * ADS 時の僅かな露出変化や閃光手榴弾の白飛びに使う。**マテリアルの色をいじって
   * 明るさを調整しないこと** — 露出の窓口はここだけ。
   */
  setExposureBias(ev) {
    this.imageProcessing.exposure = this._baseExposure * 2 ** ev;
    return this;
  }

  /* ================================================================== */
  /* Shadows                                                            */
  /* ================================================================== */

  _setupShadows(ctx, q) {
    const sun = ctx.get('sky').sun;

    const csm = new CascadedShadowGenerator(q.shadowMapSize, sun, true);
    csm.numCascades = q.cascades;
    csm.lambda = 0.86;
    csm.cascadeBlendPercentage = 0.06;
    csm.shadowMaxZ = q.shadowDistance;
    csm.depthClamp = true;
    /**
     * カスケードをテクセル単位にスナップする。これをやらないとカメラの微小な移動で
     * 影の縁がジリジリと animate する (Three 版が texel snapping を自前実装していた
     * のと同じ目的)。
     */
    csm.stabilizeCascades = true;
    /**
     * `autoCalcDepthBounds` はシーン深度から各カスケードの範囲を毎フレーム決め直す。
     * 近景の影の解像度は上がるが、**カメラが動くたびに分割位置が変わる**ので
     * 決定的キャプチャでは切る (フレーム数が変われば絵が変わってしまう)。
     */
    csm.autoCalcDepthBounds = !ctx.config.deterministic;

    /**
     * PCSS (接触硬化)。接地点で影が締まり、離れるほどぼける。README の品質バー
     * 「Contact shadows ... clear key/fill/rim separation」に対応する。
     */
    if (q.shadowMapSize >= 2048) {
      csm.useContactHardeningShadow = true;
      csm.contactHardeningLightSizeUVRatio = 0.06;
    } else {
      csm.usePercentageCloserFiltering = true;
    }
    csm.filteringQuality = CascadedShadowGenerator.QUALITY_HIGH;
    csm.bias = 0.008;
    csm.normalBias = 0.02;

    this.csm = csm;
  }

  /**
   * メッシュを影のキャスタとして登録する。
   *
   * `mesh.metadata.owNoShadow === true` のものは弾く。ARCHITECTURE.md にある通り
   * これが **唯一の影キャスタ切り替えスイッチ**で、ai の画面外 LOD が依存している。
   */
  addShadowCaster(mesh, includeDescendants = true) {
    if (!mesh || mesh.metadata?.owNoShadow) return;
    this.csm?.addShadowCaster(mesh, includeDescendants);
  }

  removeShadowCaster(mesh) {
    this.csm?.removeShadowCaster(mesh);
  }

  /* ================================================================== */
  /* Clustered lights                                                   */
  /* ================================================================== */

  _setupClusteredLights() {
    /**
     * WebGL2 では clustered lighting が使えない環境がある。使えない場合はコンテナを
     * 作らず addLight() を素通しにする (ライトはシーンに直接効く)。この経路では
     * Three 版と同じ再コンパイル問題が再発しうるが、WebGL2 はあくまで縮退動作なので
     * 許容する。**黙って劣化させない**よう警告は出す。
     */
    const container = new ClusteredLightContainer('clusteredLights', [], this.scene);
    if (!container.isSupported) {
      console.warn('[render] clustered lighting 非対応。ライトは通常経路で描画します。');
      container.dispose();
      this.clustered = null;
      return;
    }
    /**
     * タイル数は「クラスタリング処理の速さ」と「描画時のライト絞り込みの効き」の
     * トレードオフ。既定より少し細かくして、狭い路地で多数の実用光源が重なる状況を
     * 想定する。
     */
    container.horizontalTiles = 24;
    container.verticalTiles = 14;
    container.depthSlices = 24;
    this.clustered = container;
  }

  /**
   * 点光源 / スポットライトを登録する。
   *
   * Three 版と違い、呼び出し側は **距離カリングもバラストも一切気にしなくてよい**
   * (クラスタリングが GPU 側で絞るため、シェーダから見たライト数は常に一定)。
   * ARCHITECTURE.md の「The point-light count is a shader permutation key」の節は
   * この構成では該当しない。
   */
  addLight(light) {
    if (!light) return light;
    this.lights.push(light);
    if (this.clustered && ClusteredLightContainer.IsLightSupported(light)) {
      this.clustered.addLight(light);
    }
    return light;
  }

  removeLight(light) {
    const i = this.lights.indexOf(light);
    if (i >= 0) this.lights.splice(i, 1);
    this.clustered?.removeLight(light);
  }

  /* ================================================================== */
  /* Post-processing                                                    */
  /* ================================================================== */

  _setupPipelines(ctx, q) {
    const cam = this.camera;

    /**
     * メインのポストチェイン。第 2 引数 true = HDR。
     *
     * **カメラは 1 台**なので、ここに挿したポストはワールドにもビューモデルにも
     * 等しく掛かる (core/engine.js の RENDER_GROUP のコメント参照)。これが
     * 「ビューモデルの露出がワールドから外れない」ことの根拠。
     */
    const pipe = new DefaultRenderingPipeline('owDefault', true, this.scene, [cam]);

    // --- bloom -------------------------------------------------------
    pipe.bloomEnabled = q.bloom;
    // しきい値は「太陽・マズルフラッシュ・実用光源だけが光る」ように高めに取る。
    // 低くすると明るい壁までにじみ、絵が眠くなる。
    pipe.bloomThreshold = 0.86;
    pipe.bloomWeight = 0.22;
    pipe.bloomKernel = 64;
    pipe.bloomScale = 0.5;

    // --- AA ----------------------------------------------------------
    // TAA を使う場合、FXAA は二重にぼかすので切る。
    pipe.fxaaEnabled = !q.taa;
    // 軽いシャープ。TAA のにじみを戻すため。
    pipe.sharpenEnabled = q.taa;
    if (pipe.sharpenEnabled) {
      pipe.sharpen.edgeAmount = 0.22;
      pipe.sharpen.colorAmount = 1.0;
    }

    // --- 被写界深度 (ADS 時のみ weapons が有効化する) ------------------
    pipe.depthOfFieldEnabled = false;
    pipe.depthOfFieldBlurLevel = 1;

    // --- グレイン / 色収差 -------------------------------------------
    // 「Nothing perfectly clean」の一環。強すぎると安っぽくなるので控えめに。
    // animated は決定的キャプチャでは切る (フレームごとに絵が変わるため)。
    pipe.grainEnabled = true;
    pipe.grain.intensity = 3.2;
    pipe.grain.animated = !ctx.config.deterministic;
    pipe.chromaticAberrationEnabled = true;
    pipe.chromaticAberration.aberrationAmount = 12;
    pipe.chromaticAberration.radialIntensity = 0.6;

    this.pipeline = pipe;

    // --- SSAO --------------------------------------------------------
    if (q.gtao) {
      /**
       * Three 版は GTAO を自前実装していた。Babylon の SSAO2 は水平ベースだが実装済み
       * で安定している。ssaoRatio は解像度比 — 0.5 で半解像度。
       */
      const ssao = new SSAO2RenderingPipeline(
        'owSsao',
        this.scene,
        { ssaoRatio: 0.5, blurRatio: 1 },
        [cam]
      );
      ssao.radius = 1.1;
      ssao.totalStrength = 1.05;
      ssao.expensiveBlur = true;
      ssao.samples = 16;
      ssao.maxZ = 60;
      this.ssao = ssao;
    }

    // --- TAA ---------------------------------------------------------
    if (q.taa) {
      /**
       * TAA。
       *
       * `disableOnCameraMove` は既定 true だが、FPS では常時カメラが動くためそれでは
       * 事実上無効になる。false にして常に効かせ、代わりに factor を控えめにして
       * ゴーストを抑える。
       *
       * **決定的キャプチャとの関係**: TAA は履歴を積むので、シャッターまでに十分な
       * フレーム数を送る必要がある。tools/baseline.mjs が settle フレームを送るのは
       * このため。送るフレーム数が run ごとに変わると収束状態が変わりピクセルが
       * 一致しないので、lockstep が必須になる。
       */
      const taa = new TAARenderingPipeline('owTaa', this.scene, [cam]);
      taa.samples = 16;
      taa.factor = 0.08;
      taa.disableOnCameraMove = false;
      this.taa = taa;
    }

    // --- モーションブラー ---------------------------------------------
    if (q.motionBlur) {
      /**
       * オブジェクト単位のモーションブラー。velocity バッファを要求するので、
       * 有効にすると prepass のコストが乗る。
       */
      const mb = new MotionBlurPostProcess('owMotionBlur', this.scene, 1.0, cam);
      mb.motionStrength = 0.6;
      mb.motionBlurSamples = 12;
      mb.isObjectBased = true;
      this.motionBlur = mb;
    }
  }

  /**
   * 追加のポストプロセスを差し込む。fx が閃光や被弾のフルスクリーン効果に使う。
   *
   * Babylon はカメラにアタッチした順に走るので、**呼ぶ順序がそのまま描画順序**になる。
   */
  registerPass(pass) {
    this.extraPasses.push(pass);
    return pass;
  }

  /** 現在の環境マップ。fx や weapons が反射に使う。 */
  requestEnvMap() {
    return this.scene.environmentTexture;
  }

  /** ADS 用の被写界深度。weapons が呼ぶ。 */
  setDepthOfField(enabled, focusDistanceMetres = 8) {
    if (!this.pipeline) return;
    this.pipeline.depthOfFieldEnabled = enabled;
    if (enabled) {
      // Babylon の focusDistance はミリメートル。
      this.pipeline.depthOfField.focusDistance = focusDistanceMetres * 1000;
      this.pipeline.depthOfField.fStop = 2.8;
      this.pipeline.depthOfField.focalLength = 42;
    }
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  /**
   * 1 フレーム描画する。engine が最後に呼ぶ。
   *
   * `scene.render()` が影・プリパス・ポストを含めて全部やる。Three 版のようにパスを
   * 手で並べる必要はない。
   */
  render() {
    this.frame++;
    this.scene.render();
  }

  resize(w, h) {
    this.screenSize.width = w;
    this.screenSize.height = h;
    if (this.imageProcessing) this.imageProcessing.vignetteCameraFov = this.camera.fov;
  }

  dispose() {
    this.motionBlur?.dispose();
    this.taa?.dispose();
    this.ssao?.dispose();
    this.pipeline?.dispose();
    this.clustered?.dispose();
    this.csm?.dispose();
    for (const p of this.extraPasses) p.dispose?.();
    this.extraPasses.length = 0;
  }
}
