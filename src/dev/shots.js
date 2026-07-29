import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * スクリーンショットハーネスが要求できる、名前付きカメラ設定。
 *
 * 各ショットは入力を凍結し、カメラを固定し、必要ならゲームプレイの状態を強制する。
 * これにより批評家 (critic) は反復のたびに同じ構図を見ることになる。
 *
 * ショットは `{ pos:[x,y,z], look:[x,y,z], fov?, time?, apply?(engine) }`。
 * `time` は sky に渡す時刻 0..24。
 */
export const SHOTS = {
  // ---- 環境 / ライティング ----
  hero: {
    pos: [12, 1.75, 18],
    look: [-4, 2.2, -6],
    fov: 75,
    time: 16.5,
    doc: '本通りを見下ろす引きの絵 — アートディレクション全体を測る。',
  },
  interior: {
    pos: [-8.5, 1.7, 3.2],
    look: [2, 1.6, -2],
    fov: 70,
    time: 16.5,
    doc: '窓から光条が差す屋内 — バウンス、AO、ボリュメトリック。',
  },
  detail: {
    pos: [3.2, 1.35, 5.0],
    look: [1.4, 1.1, 2.2],
    fov: 45,
    time: 16.5,
    doc: '壁とプロップのマテリアル接写 — テクセル密度、法線、汚れ。',
  },
  sunset: {
    pos: [16, 3.2, 22],
    look: [-10, 3.0, -14],
    fov: 65,
    time: 19.2,
    doc: '低い太陽 — 大気散乱、長い影、god ray、ブルーム。',
  },
  night: {
    pos: [12, 1.75, 18],
    look: [-4, 2.2, -6],
    fov: 75,
    time: 1.5,
    doc: '夜 — 人工光、露出順応、暗部の影の質。',
  },

  // ---- 武器 / ビューモデル ----
  weapon: {
    pos: [6, 1.7, 10],
    look: [-2, 1.8, -2],
    fov: 80,
    time: 16.5,
    apply: (e) => e.ctx.peek('weapons')?.debugPose?.('idle'),
    doc: '腰だめのビューモデル — 銃のシルエット、マテリアル、手のリグ。',
  },
  ads: {
    pos: [6, 1.7, 10],
    look: [-2, 1.8, -2],
    fov: 58,
    time: 16.5,
    apply: (e) => e.ctx.peek('weapons')?.debugPose?.('ads'),
    doc: 'ADS — 光学サイトの整列、被写界深度、レティクル。',
  },
  muzzle: {
    pos: [6, 1.7, 10],
    look: [-2, 1.8, -2],
    fov: 80,
    time: 16.5,
    apply: (e, o) => e.ctx.peek('weapons')?.debugPose?.('fire', o),
    doc: '反動の途中でマズルフラッシュ — 形、光の回り込み、薬莢排出。',
  },

  // ---- 戦闘 / FX ----
  combat: {
    pos: [4, 1.7, 12],
    look: [-6, 1.7, -4],
    fov: 80,
    time: 16.5,
    apply: (e) => e.ctx.peek('ai')?.debugStage?.('firefight'),
    doc: '交戦中の敵 — キャラクタの質、アニメーション、着弾 FX。',
  },
  impacts: {
    pos: [2.5, 1.6, 6],
    // 5.25m 先の漆喰壁に正対させている。以前は市場の奥を向いていたため着弾が
    // 20m 以上先に出て decal が判別できず、このショットの目的を果たしていなかった。
    look: [-1.8, 1.5, 9.0],
    fov: 60,
    time: 16.5,
    apply: (e) => e.ctx.peek('fx')?.debugBurst?.('wall'),
    doc: '壁への着弾 — decal、破片、土煙、火花。',
  },
  hud: {
    pos: [12, 1.75, 18],
    look: [-4, 2.2, -6],
    fov: 80,
    time: 16.5,
    apply: (e) => e.ctx.peek('ui')?.debugState?.('combat'),
    doc: '戦闘中の HUD — レイアウト、タイポグラフィ、可読性、被弾表示。',
  },
};

export function installShotApi(engine, { capture, lockstep = false } = {}) {
  window.__SHOTS__ = SHOTS;

  /**
   * `opts.grabFrame` はハーネスがシャッターまでに送るフレーム数。マズルフラッシュ
   * (寿命 ~52ms) のような一過性のものを被写体にするショットは、これを見て撮られる
   * フレームにイベントを載せる。
   */
  window.__APPLY_SHOT__ = (name, opts = {}) => {
    const shot = SHOTS[name];
    if (!shot) return { error: `unknown shot "${name}"`, available: Object.keys(SHOTS) };

    // 実入力を凍結し、カメラをショットに渡す。
    engine.input.frozen = true;
    engine.input.enabled = false;
    const player = engine.ctx.peek('player');
    player?.setControlEnabled?.(false);

    const cam = engine.camera;
    cam.position.set(shot.pos[0], shot.pos[1], shot.pos[2]);
    /**
     * Babylon の FreeCamera は `setTarget()` で向きを決める。**この呼び出しは
     * camera.rotation を書き換える**ので、player 側が rotation を駆動している場合は
     * 先に制御を切っておく必要がある (上で setControlEnabled(false) しているのは
     * このため)。
     */
    cam.setTarget(new Vector3(shot.look[0], shot.look[1], shot.look[2]));
    if (shot.fov) {
      // config.fov と同じく「垂直 FOV の度数」なのでラジアンに直す。
      cam.fov = (shot.fov * Math.PI) / 180;
    }
    // ゲームプレイ側の整合を保つため、プレイヤーのカプセルもカメラの下に置く。
    player?.teleport?.(cam.position, cam.rotation);

    /**
     * ショットは 1 つのブラウザセッションで連続適用されるので、**前のショットの
     * ループする debug 状態を先に消す**。これが無いと muzzle ショットの連射が
     * combat の最中もマガジンを空にし続け、impacts の壁撃ちが hud ショットの背後で
     * 続いてしまう。
     */
    engine.ctx.peek('weapons')?.debugPose?.('idle');
    engine.ctx.peek('fx')?.debugBurst?.('none');
    engine.ctx.peek('ui')?.debugState?.('clean');

    if (shot.time !== undefined) engine.ctx.peek('sky')?.setTimeOfDay?.(shot.time);
    shot.apply?.(engine, opts);

    engine.events.emit('shot:applied', { name, shot });
    return { applied: name, pos: shot.pos, fov: shot.fov ?? engine.config.fov };
  };

  if (capture) {
    /**
     * キャプチャモードでは固定タイムステップにする。時間依存の効果が同じように
     * 収束するため。
     *
     * 各ステップの直前に `this._last = fake` を代入することで、rawDt が 1 フレーム目を
     * 含めて常に厳密に 1000/60 になる。engine.start() と、将来 prewarm を入れた場合の
     * 両方が `_last` に実時計を書き込むため、これが無いと 1 フレーム目の dt が
     * 「実時計が書かれていれば 0、書かれていなければ 1/60」という boot 経路依存の
     * 差になり、すべての積分器に 1 フレームぶんのズレが入る。
     */
    let fake = 0;
    engine.step = ((orig) =>
      function () {
        this._last = fake;
        fake += 1000 / 60;
        return orig.call(this, fake);
      })(engine.step);
  }

  window.__RENDER_INFO__ = null;
  const snapInfo = () => {
    const babylon = engine.babylon;
    const scene = engine.scene;
    window.__RENDER_INFO__ = {
      frame: engine.time.frame,
      backend: engine.backend,
      // Babylon の統計。Three の renderer.info に相当するもの。
      calls: scene.getEngine().drawCalls ?? 0,
      tris: scene.getActiveIndices ? scene.getActiveIndices() / 3 : 0,
      meshes: scene.getActiveMeshes ? scene.getActiveMeshes().length : 0,
      textures: babylon._internalTexturesCache?.length ?? 0,
      ms: engine.time.dt * 1000,
    };
  };

  /**
   * ロックステップキャプチャ (`?capture=1&lockstep=1`) — 決定性の要。
   *
   * 解決している問題: engine 自身の rAF ループは、ドライバが往復している間
   * (__READY__ の waitForFunction、ショットを適用する evaluate、スクリーンショットの
   * RPC 自体) も回り続ける。その往復に何フレーム入るかは実時計依存なので、シャッターが
   * 切られた瞬間の `engine.time.frame` が run ごとに 10〜20 フレームぶれる。絶対
   * フレーム番号に位相同期しているものすべて — TAA のジッタ、AO/SSR のノイズ回転、
   * 露出順応、スクリプトされた一過性イベントの拍 — がそのたびに違う解に落ちる。
   * **これが 2 回の実行が一致しなかった原因**であり、boot 時間を変える変更が
   * 「視覚的変化」に見えた原因でもある。
   *
   * 対策: ロックステップでは engine は自分でフレームを一切スケジュールしない。
   * フレームは __PUMP__(n) の中でだけ、正確に n 回進む。したがってシャッター時の
   * フレーム番号は定数になり、スクリーンショット取得中は何も進まない。
   */
  if (lockstep) {
    engine.start = function () {
      this._running = true;
    };
    window.__LOCKSTEP__ = true;

    /** engine のフレームを正確に n 回進める。1 フレーム 1 rAF で present させる。 */
    window.__PUMP__ = (n = 1) =>
      new Promise((resolve) => {
        let i = 0;
        const tick = () => {
          engine.step();
          snapInfo();
          if (++i >= n) resolve(engine.time.frame);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

    /** シミュレーションを進めずに n 回 rAF を空回しし、合成器に最後のフレームを
     *  拾わせる。状態は一切進まない。 */
    window.__PRESENT__ = (n = 2) =>
      new Promise((resolve) => {
        let i = 0;
        const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });
  } else {
    window.__LOCKSTEP__ = false;
    // 自走モード: engine が自分で回すので __PUMP__ は n フレーム待つだけ。
    window.__PUMP__ = (n = 1) =>
      new Promise((resolve) => {
        let i = 0;
        const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });
    window.__PRESENT__ = window.__PUMP__;
    const info = () => {
      snapInfo();
      requestAnimationFrame(info);
    };
    requestAnimationFrame(info);
  }

  return { pump: window.__PUMP__, present: window.__PRESENT__, lockstep: !!lockstep };
}
