import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import { Engine as WebGL2Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color4 } from '@babylonjs/core/Maths/math.color.js';

import { Registry, EventBus } from './registry.js';
import { FIXED_DT, MAX_SUBSTEPS } from './config.js';
import { Input } from './input.js';
import { Rng } from './rng.js';

/**
 * レイヤーマスク。
 *
 * ワールドとビューモデルの描き分けは **renderingGroupId** で行い、layerMask は
 * 「特定のパスから外したいもの」用に残してある (影のプローブ等)。区別の理由は
 * RENDER_GROUP のコメントを参照。
 */
export const LAYER = {
  /** 通常のワールドジオメトリ。 */
  WORLD: 0x0fffffff,
};

/**
 * 描画グループ — ワールドとビューモデル(一人称の手/銃)の描き分け。
 *
 * ## なぜ「2 つの Scene」でも「2 台のカメラ」でもないのか
 *
 * Three.js 版は `scene` と `viewScene` の 2 シーン構成で、ビューモデル専用の
 * ライトリグを持っていた。その結果 README に記録された既知の根本原因が生まれた:
 *
 *   > viewmodel の light rig が world の約 20 倍の irradiance を出しており、
 *   > view scene では *黒* のマテリアルですら L=110 (背景 91) で描かれる。
 *   > 全武器の albedo を物理値の 1/3 に誤魔化して辻褄を合わせているため、
 *   > ゲーム中で最も注視されるオブジェクトのマテリアル表現力が頭打ち。
 *
 * 原因は「2 つの独立した照明環境を人手で一致させ続ける」構造そのもの。放置すれば
 * 移植先でも必ず再発するので、**照明・露出・トーンマップを 1 本しか持たない構成**に
 * する必要がある。
 *
 * 最初 activeCameras に 2 台並べる構成にしたが、これは誤りだった:
 * **Babylon のポストプロセスはカメラ単位で適用される**ため、パイプラインを 1 台目に
 * だけ付けるとビューモデルにトーンマップもブルームも露出も掛からず、両方に付けると
 * ポストが 2 回走る。どちらも「照明環境が 2 つある」のと同じ病に戻る。
 *
 * 正解は **1 カメラ + renderingGroupId**:
 *
 *   group 0 … ワールド
 *   group 1 … ビューモデル (このグループの手前で **深度だけクリア**する)
 *
 * 深度クリアにより銃が壁を貫通しない (viewScene を分けていた本来の目的)。同時に
 * ポストチェインは 1 本なので、ビューモデルは定義上ワールドと同一の露出・同一の
 * IBL で焼かれる。20 倍のズレは構造的に発生しえない。
 *
 * ## 代償 (意図的に受け入れているもの)
 *
 * ビューモデル専用のニアクリップと FOV を持てない。したがって:
 *
 *   - ビューモデルは camera.minZ (0.05 m) より手前に置けない。weapons 側は
 *     必ずこれより奥に配置すること。
 *   - ADS でワールド FOV を絞ると武器も一緒にスケールする。実機の FPS は武器に
 *     別 FOV を持たせるのが普通だが、weapons 側が ADS 遷移で位置と姿勢を動かす
 *     ぶんで吸収する方針とした。
 *
 * この 2 点は「照明が 1 本であること」と引き換えに選んだ。逆にすると README に
 * 記録された事故を再導入することになる。
 */
export const RENDER_GROUP = {
  WORLD: 0,
  VIEWMODEL: 1,
};

/**
 * Engine はフレームループと、全サブシステムに配る共有コンテキストだけを持つ。
 * 各サブシステムが何をするかは一切知らない — 順序付けだけが仕事。
 *
 * フレーム順:
 *   1. input.beginFrame()
 *   2. fixedUpdate(FIXED_DT) xN   — physics, 決定的なゲームプレイ
 *   3. update(dt)                 — アニメーション, カメラ, AI 判断
 *   4. lateUpdate(dt)             — 最終トランスフォームを見る必要があるもの
 *   5. render サブシステムが描画
 *   6. input.endFrame()
 *
 * この順序は Three 版から一切変えていない。サブシステムの移植時に
 * 「いつ呼ばれるか」を考え直さずに済ませるため。
 */
export class Engine {
  /**
   * WebGPU の初期化は非同期なので、コンストラクタではなく静的ファクトリを使う。
   *
   * WebGPU が使えない環境では WebGL2 に自動フォールバックする。フォールバック
   * したかどうかは `engine.backend` で判別でき、`render` サブシステムはこれを見て
   * compute shader を使うパスを落とす。**黙ってフォールバックさせない**のが重要で、
   * ピクセルゲート (tools/imagediff.mjs) は backend が違えば一致しないため、
   * 比較対象を取り違えると「最適化で絵が変わった」と誤診する。
   */
  static async create({ canvas, config }) {
    const forced = config.backend; // 'webgpu' | 'webgl2' | undefined (=auto)
    let engine = null;
    let backend = null;

    const wantWebGPU = forced !== 'webgl2' && (await WebGPUEngine.IsSupportedAsync);
    if (wantWebGPU) {
      try {
        const gpu = new WebGPUEngine(canvas, {
          antialias: false, // AA は TAA / FXAA がポストで担当する
          stencil: true,
          powerPreference: 'high-performance',
          // 決定的キャプチャのため、ブラウザ側の暗黙の DPR 補正を切る
          adaptToDeviceRatio: false,
        });
        await gpu.initAsync();
        engine = gpu;
        backend = 'webgpu';
      } catch (err) {
        console.warn('[engine] WebGPU init failed, falling back to WebGL2:', err);
        engine = null;
      }
    }

    if (!engine) {
      engine = new WebGL2Engine(
        canvas,
        false,
        {
          stencil: true,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: false,
          antialias: false,
        },
        false
      );
      backend = 'webgl2';
    }

    if (forced === 'webgpu' && backend !== 'webgpu') {
      throw new Error('?backend=webgpu was requested but WebGPU is unavailable in this browser');
    }

    return new Engine({ canvas, config, engine, backend });
  }

  constructor({ canvas, config, engine, backend }) {
    this.canvas = canvas;
    this.config = config;
    /** Babylon の描画エンジン (WebGPUEngine か Engine)。 */
    this.babylon = engine;
    /** 'webgpu' | 'webgl2' — サブシステムが機能分岐に使う。 */
    this.backend = backend;

    this.registry = new Registry();
    this.events = new EventBus();
    this.input = new Input(canvas, config);
    this.rng = new Rng(config.deterministic ? 0x5eed1234 : (Math.random() * 2 ** 32) >>> 0);

    const scene = new Scene(engine);
    /**
     * 右手系に固定する。
     *
     * Babylon の既定は左手系だが、`src/dev/shots.js` のカメラ座標、ワールドの
     * レイアウト、既存のすべての方向ベクトルは Three.js (右手系) の意味で書かれて
     * いる。ここを左手系のままにすると、移植のたびに Z の符号を各所で反転させる
     * ことになり、しかも間違えても「なんとなく動いてしまう」ため発見が遅れる。
     * SSOT として engine で一度だけ決めておく。
     */
    scene.useRightHandedSystem = true;
    /** 空は sky サブシステムが描くので、シーン自体のクリア色は黒でよい。 */
    scene.clearColor = new Color4(0, 0, 0, 1);
    this.scene = scene;

    /**
     * 唯一のカメラ。回転は player サブシステムが yaw/pitch で駆動する。
     *
     * カメラを 1 台に絞る理由は RENDER_GROUP のコメントを参照 (要点: Babylon の
     * ポストプロセスはカメラ単位なので、2 台にするとビューモデルの露出が
     * ワールドから外れる — Three 版で破綻した構図の再導入になる)。
     */
    const camera = new FreeCamera('worldCamera', new Vector3(0, 1.7, 0), scene);
    camera.minZ = 0.05;
    camera.maxZ = 1200;
    camera.fov = degToRad(config.fov);
    camera.layerMask = LAYER.WORLD;
    /** 入力は core/input.js が一元管理する。Babylon 内蔵の操作は必ず切る。 */
    camera.inputs.clear();
    this.camera = camera;
    scene.activeCamera = camera;

    scene.autoClear = true;
    scene.autoClearDepthAndStencil = true;
    /**
     * ビューモデルのグループに入る **手前で深度をクリア**する。
     *
     * 第 2 引数 (autoClearDepthStencil) が true、第 3 引数 (depth) が true、
     * 第 4 引数 (stencil) が false。カラーはクリアしないので、ワールドの絵の上に
     * 深度だけリセットして重ね描きされる = 銃が壁を貫通しない。
     */
    scene.setRenderingAutoClearDepthStencil(RENDER_GROUP.VIEWMODEL, true, true, false);

    this.time = {
      /** 開始からの秒数 (scale 適用済み)。 */ elapsed: 0,
      /** 開始からの実時間秒。 */ raw: 0,
      /** 直前フレームの delta (scale 適用・クランプ済み)。 */ dt: 0,
      /** 固定ステップ。 */ fixed: FIXED_DT,
      /** 直近 2 つの物理ステップ間の補間係数 0..1。 */ alpha: 0,
      scale: 1,
      frame: 0,
    };

    this.ctx = {
      engine: this,
      /** Babylon の Scene。全サブシステムが共有する唯一のシーン。 */
      scene,
      camera,
      /** レイヤーマスク定数。 */
      LAYER,
      /** 描画グループ定数。ビューモデルのメッシュは RENDER_GROUP.VIEWMODEL を立てる。 */
      RENDER_GROUP,
      canvas,
      config,
      events: this.events,
      input: this.input,
      time: this.time,
      rng: this.rng,
      /** 'webgpu' | 'webgl2' */
      backend,
      get: (id) => this.registry.get(id),
      peek: (id) => this.registry.peek(id),
      has: (id) => this.registry.has(id),
    };

    /**
     * サブシステム別の所要時間 (ms)。`?systime=1` で有効。
     *
     * ## なぜ必要か
     *
     * README に記録された最大の教訓は「中央値のフレーム時間は実際の問題を隠す」
     * だった。静止カメラで 94fps を報告しながら、実プレイでは 728〜1236ms の停止が
     * 起きていた。原因の特定には **フレームごとの内訳** が要る。
     *
     * ヒッチが出たときに「どのサブシステムのどのフェーズか」を名指しできないと、
     * 推測でシェーダやポストを疑って時間を溶かすことになる (実際に溶かした)。
     *
     * 常時有効にしないのは、performance.now() の呼び出し自体がフレームあたり
     * 数十回増えるため。
     */
    this.sysTime = null;
    this._accum = 0;
    this._last = 0;
    this._running = false;
    this._onResize = () => this.resize();
  }

  add(SystemClass, opts) {
    this.registry.add(new SystemClass(opts));
    return this;
  }

  async init() {
    const order = this.registry.resolve();
    for (const sys of order) {
      const t0 = performance.now();
      await sys.init?.(this.ctx);
      const ms = performance.now() - t0;
      if (ms > 50) console.info(`[engine] ${sys.constructor.id} init ${ms.toFixed(0)}ms`);
    }
    this.input.attach();
    addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    // Babylon はキャンバスの実解像度を自分で持つので、まず engine に知らせる。
    this.babylon.resize();
    for (const sys of this.registry.with('resize')) sys.resize(w, h, this.ctx);
    this.events.emit('resize', { width: w, height: h });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
  }

  _loop(now) {
    if (!this._running) return;
    requestAnimationFrame(this._loop);
    this.step(now);
  }

  /** 1 フレーム進める。キャプチャハーネスが手動でフレームを送れるよう公開する。 */
  step(now = performance.now()) {
    const t = this.time;
    // タブ切り替えやブレークポイントでシミュレーションが飛ばないようクランプ。
    const rawDt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    t.raw += rawDt;
    t.dt = rawDt * t.scale;
    t.elapsed += t.dt;
    t.frame++;

    this.input.beginFrame();

    this._accum += t.dt;
    let steps = 0;
    const fixedSystems = this.registry.with('fixedUpdate');
    const fixedT0 = this.sysTime ? performance.now() : 0;
    while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (const sys of fixedSystems) sys.fixedUpdate(FIXED_DT, this.ctx);
      this._accum -= FIXED_DT;
      steps++;
    }
    if (this.sysTime) {
      this.sysTime['_fixed.total'] = performance.now() - fixedT0;
      this.sysTime['_fixed.steps'] = steps;
    }
    if (steps === MAX_SUBSTEPS) this._accum = 0; // 積み残しは捨てる (spiral of death 回避)
    t.alpha = this._accum / FIXED_DT;

    const st = this.sysTime;
    if (st) {
      for (const sys of this.registry.with('update')) {
        const a = performance.now();
        sys.update(t.dt, this.ctx);
        st[`${sys.constructor.id}.update`] = performance.now() - a;
      }
      for (const sys of this.registry.with('lateUpdate')) {
        const a = performance.now();
        sys.lateUpdate(t.dt, this.ctx);
        st[`${sys.constructor.id}.late`] = performance.now() - a;
      }
    } else {
      for (const sys of this.registry.with('update')) sys.update(t.dt, this.ctx);
      for (const sys of this.registry.with('lateUpdate')) sys.lateUpdate(t.dt, this.ctx);
    }

    const renderSystem = this.registry.peek('render');
    if (typeof renderSystem?.render === 'function') {
      if (st) {
        const a = performance.now();
        renderSystem.render(this.ctx);
        st['render.draw'] = performance.now() - a;
      } else {
        renderSystem.render(this.ctx);
      }
    }

    this.input.endFrame();
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.input.detach();
    for (const sys of [...this.registry.ordered].reverse()) sys.dispose?.();
    this.events.clear();
    this.scene.dispose();
    this.babylon.dispose();
  }
}

/**
 * config.fov は Three 版から引き継いだ「垂直 FOV の度数」。Babylon の
 * `camera.fov` はラジアンで、既定では垂直方向 (FOVMODE_VERTICAL_FIXED) なので
 * 単純変換でよい。ここを間違えると全ショットの画角がズレて pixel gate が常に
 * 赤になるため、変換は必ずこの 1 箇所を通す。
 */
export function degToRad(deg) {
  return (deg * Math.PI) / 180;
}
