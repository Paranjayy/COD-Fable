import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline.js';
import { TAARenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline.js';
import { MotionBlurPostProcess } from '@babylonjs/core/PostProcesses/motionBlurPostProcess.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { ClusteredLightContainer } from '@babylonjs/core/Lights/Clustered/clusteredLightContainer.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
/**
 * **副作用 import。消さないこと。**
 *
 * Babylon 9 はエンジンの機能もツリーシェイキングする。MRT (複数レンダーターゲット)
 * は既定では生えておらず、これを import しないと GeometryBufferRenderer が
 * 「this._getEngine(...).createMultipleRenderTarget is not a function」で落ちる。
 * SSAO2 が depth/normal を得るのに GeometryBufferRenderer を使うため必須。
 *
 * 「使っていない import」に見えるので lint やエディタの自動整理で消されやすい。
 */
import '@babylonjs/core/Engines/Extensions/engine.multiRender.js';
/**
 * WebGPU 用の MRT 実装。**上の import とは別物なので両方要る。**
 *
 * Engines/Extensions/ 側は ThinEngine (WebGL 系) に生やすもので、WebGPUEngine には
 * Engines/WebGPU/Extensions/ 側が必要。片方だけだと WebGPU 実行時に同じ
 * 「createMultipleRenderTarget is not a function」で落ちる。
 */
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender.js';
/**
 * **副作用 import。** `scene.enableGeometryBufferRenderer()` はこのモジュールが
 * Scene に生やす。SSAO2 と MotionBlur が depth/normal/velocity を取る経路。
 */
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent.js';

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
    this._setupClusteredLights(q);
    /**
     * ?post=0 でポストチェインを丸ごと飛ばせる。
     *
     * 「シーンは描けているがポストが画面を食っている」のか「そもそも何も描けて
     * いない」のかを切り分けるのに要る。エラーが出ないまま真っ黒になる失敗は、
     * この 2 つを分けないと原因に近づけない。
     */
    if (ctx.config.post !== false) this._setupPipelines(ctx, q);
    else console.info('[render] ポストプロセスは ?post=0 で無効化されています。');

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
     * `autoCalcDepthBounds` は **常に切る**。
     *
     * 当初は「決定的キャプチャのときだけ切る」つもりだったが、実測の結果これが
     * ヒッチの唯一の原因だった。
     *
     * ## 実測 (1512x982, ultra, 400 フレーム, 発砲なし)
     *
     * サブシステム別の計測 (?systime=1) で、ヒッチしたフレームの内訳は:
     *
     *     frame 208  555.1ms  render.draw=554.1ms  _fixed.total=0.2ms  weapons.late=0.1ms
     *     frame 166  551.8ms  render.draw=551.3ms  ...
     *     frame 250  470.9ms  render.draw=470.3ms  ...
     *
     * **フレーム時間のほぼ全部が render.draw の中**で、他のサブシステムは 1ms 未満。
     * シェーダのコンパイルではない (compiledDuringPlay = 0)。
     *
     * 原因は autoCalcDepthBounds が使う DepthReducer が **GPU→CPU の読み戻し**を
     * 行うこと。読み戻しはパイプラインを同期させるので、WebGPU では特に高くつく。
     *
     * 失うもの: 近景の影の解像度が少し落ちる。lambda を上げて手動の分割で妥協する。
     * 得るもの: 数百 ms のヒッチが消える。README の「中央値のフレーム時間は実際の
     * 問題を隠す」という教訓がそのまま当てはまる — p50 は良好なのに p99 が 4fps
     * だった。
     */
    csm.autoCalcDepthBounds = false;

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

  _setupClusteredLights(q) {
    if (q.clusteredLights === false) {
      console.info('[render] clustered lighting は設定で無効化されています。');
      this.clustered = null;
      return;
    }
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
    // 12 は強すぎて輪郭に赤緑の斑点が出た (実測)。実写のレンズ収差はもっと控えめ。
    pipe.chromaticAberration.aberrationAmount = 2.4;
    pipe.chromaticAberration.radialIntensity = 0.5;

    this.pipeline = pipe;

    // --- SSAO --------------------------------------------------------
    if (q.gtao) {
      /**
       * Three 版は GTAO を自前実装していた。Babylon の SSAO2 は水平ベースだが実装済み
       * で安定している。ssaoRatio は解像度比 — 0.5 で半解像度。
       */
      /**
       * ## SSAO の経路 — 2 回の失敗を経てここに落ち着いた
       *
       * SSAO2 は depth/normal を GeometryBufferRenderer か PrePassRenderer から取れる。
       *
       * **試行 1: prepass (forceGeometryBuffer=false)**
       *   → 毎フレーム「Cannot read properties of undefined (reading '2')」で落ちた。
       *     `scene.enablePrePassRenderer()` を呼んで解決するかと思ったが、
       *     **今度はシーンが一切描かれなくなった** (エラーゼロ・fps 400・画面は
       *     HUD だけ)。DefaultRenderingPipeline との合成が噛み合っていない。
       *     「fps が上がった」を成果と読み違えかけた典型例。
       *
       * **試行 2: geometry buffer をフル解像度で**
       *   → 描画は正しいが **3M 三角形のシーンを毎フレーム二度描く**ことになり、
       *     フレーム時間の 85% を食った (p50 83fps / p99 3fps / ヒッチ 19 回)。
       *
       * **採用: geometry buffer を半解像度で明示的に作る。**
       *   AO は低周波の情報なので半解像度で十分。二度描きのコストが 1/4 になる。
       *   MotionBlur も同じ renderer を共有させ、経路を 1 本に保つ (別経路にすると
       *   WebGPU のバインドグループが食い違い、両方有効なときだけ落ちる)。
       */
      const gbuf = this.scene.enableGeometryBufferRenderer(0.5);
      const ssao = new SSAO2RenderingPipeline(
        'owSsao',
        this.scene,
        { ssaoRatio: 0.5, blurRatio: 1 },
        [cam],
        gbuf ?? true
      );
      ssao.radius = 1.1;
      ssao.totalStrength = 1.05;
      // expensiveBlur は名前の通り高い。半解像度の AO には効果より代償が大きい。
      ssao.expensiveBlur = false;
      ssao.samples = 12;
      ssao.maxZ = 60;
      this.ssao = ssao;
      this._gbuf = gbuf;
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
       * オブジェクト単位のモーションブラー。velocity バッファを要求する。
       *
       * **最後の引数 `forceGeometryBuffer = true` が必須。**
       *
       * SSAO2 と MotionBlur は両方とも depth/normal/velocity を必要とするが、既定では
       * 前者を GeometryBufferRenderer、後者を prepass から取ろうとする。2 つの経路が
       * 同時に生きると WebGPU のバインドグループが食い違い、**両方を有効にしたときだけ**
       * 毎フレーム
       * 「Failed to execute 'createBindGroup' ... 'resource' ... Required member is
       *  undefined」で落ちる。
       *
       * 実際に二分探索で確かめた挙動 (q=high, 640x360, settle=20):
       *   taa=0       → 9 件のエラー (TAA は無関係)
       *   gtao=0      → 0 件
       *   mblur=0     → 0 件
       *   clustered=0 → 12 件 (clustered も無関係)
       *
       * つまり「SSAO2 と MotionBlur の両方が有効なとき」だけの問題。両方を
       * GeometryBufferRenderer に揃えると経路が 1 本になり解消する。
       */
      /**
       * 最後の引数に **SSAO と同じ GeometryBufferRenderer を渡す**。
       * 別経路 (prepass) にすると WebGPU のバインドグループが食い違い、
       * 両方有効なときだけ毎フレーム
       * 「createBindGroup ... Required member is undefined」で落ちる (実測済み)。
       */
      const mb = new MotionBlurPostProcess(
        'owMotionBlur',
        this.scene,
        1.0,
        cam,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        this._gbuf ?? true
      );
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
   *
   * ## beginFrame() / endFrame() を必ず自分で呼ぶこと
   *
   * Babylon の通常の使い方は `engine.runRenderLoop(() => scene.render())` で、この
   * **runRenderLoop がフレームの前後で beginFrame() と endFrame() を呼んでいる**。
   * このプロジェクトは決定的キャプチャのために自前でループを回している
   * (core/engine.js の step()) ので、その 2 つは誰も呼んでくれない。
   *
   * WebGL では省いてもほぼ動いてしまうが、**WebGPU では endFrame() がコマンド
   * バッファの submit と present を行う**ため、省くと:
   *
   *   - 例外は一切出ない
   *   - scene.getActiveIndices() は正しい値を返す (シーンは「描いている」)
   *   - しかしキャンバスは完全に真っ黒
   *
   * という、原因に辿り着きにくい形で失敗する。実際この移植で数十分を溶かした。
   */
  render() {
    this.frame++;
    this.renderer.beginFrame();
    this.scene.render();
    this.renderer.endFrame();
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
