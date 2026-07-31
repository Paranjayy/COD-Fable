/**
 * パイプラインの事前生成 (pre-warm)。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ## なぜ必要か — Three 版と同じ病が WebGPU でも出た
 *
 * README に記録された、このプロジェクト最大の性能問題:
 *
 *   > 実プレイ時に 34+ 本の WebGL プログラムがフレーム中に遅延コンパイルされ、
 *   > 728〜1236 ms の停止を起こしていた。`prewarm.js` がこれを消した。
 *
 * Babylon + WebGPU への移植でこの仕組みを落としたところ、**同じ病が別の形で
 * 再発した**。実測 (1512x982, ultra, 500 フレーム, カメラ旋回あり):
 *
 *   fps p50 54 / p95 45 / **p99 3**
 *   ヒッチ 12 回 (2.73%)、最悪 374 ms
 *   ヒッチしたフレームの内訳は render.draw=373.7ms (他は 0.2ms 未満)
 *
 * ただし `engine._compiledEffects` の本数は **実行中まったく増えていない**。
 * つまり Effect (シェーダ) のコンパイルではない。
 *
 * 犯人は **WebGPU の GPURenderPipeline 生成**。Babylon は Effect ごとではなく
 * 「Effect × 頂点レイアウト × ブレンド × 深度 × ターゲット形式」の組み合わせごとに
 * パイプラインを作る。カメラが旋回して新しいメッシュが視界に入るたびに新しい
 * 組み合わせが要求され、そのフレームだけ数百 ms 止まる。Effect 数を見ていても
 * 気付けないのが厄介な点。
 *
 * ## 対策
 *
 * ゲームが始まる前に、**全マテリアル × 全メッシュ** の組み合わせを 1 回ずつ
 * 強制コンパイルする。Babylon の `Material.forceCompilationAsync(mesh)` が
 * Effect の生成とパイプラインの準備をまとめて行う。
 *
 * ## 罠
 *
 * 1. **影のバリアントは別パイプライン**。CSM は `scene.customRenderTargets` 側で
 *    描かれるので、通常描画を warm しても影用は warm されない。影キャスタとして
 *    登録されたメッシュは shadow generator 側でも 1 フレーム描いておく必要がある。
 * 2. **geometry buffer のバリアントも別**。SSAO が使う G バッファは専用シェーダで
 *    描かれる。こちらも 1 フレーム走らせる。
 * 3. 事前生成は **決定的でなければならない**。ここで `Math.random()` や実時計に
 *    触れると、pre-warm の有無で絵が変わり pixel gate が使えなくなる。README の
 *    「pre-warm が視覚的変化に見えた」事故はまさにこれだった。
 */

/**
 * 全マテリアルのパイプラインを事前生成する。
 *
 * @returns {Promise<{ok:boolean, materials:number, meshes:number, ms:number, reason?:string}>}
 */
export async function prewarm(engine) {
  const t0 = performance.now();
  const scene = engine.scene;

  const meshes = scene.meshes.filter(
    (m) => m.material && m.getTotalVertices?.() > 0 && m.isEnabled?.()
  );
  if (!meshes.length) {
    return { ok: false, reason: 'no meshes to warm', materials: 0, meshes: 0, ms: 0 };
  }

  /**
   * マテリアル × メッシュの組み合わせを潰す。
   *
   * 同じマテリアルでも **頂点レイアウトが違えば別パイプライン**になるので、
   * 「マテリアルごとに 1 回」では足りない。ただしワールドはパレットキーごとに
   * 統合済みなので、実際の組み合わせ数はメッシュ数と同程度に収まる。
   */
  const jobs = [];
  const seen = new Set();
  for (const mesh of meshes) {
    const mat = mesh.material;
    const key = `${mat.uniqueId}:${mesh.getTotalVertices()}:${mesh.hasThinInstances ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (typeof mat.forceCompilationAsync !== 'function') continue;
    jobs.push(
      mat.forceCompilationAsync(mesh).catch((err) => {
        // 1 つ失敗しても全体を止めない。warm できなかったマテリアルは実行時に
        // コンパイルされるだけで、絵は正しく出る。
        console.warn(`[prewarm] ${mat.name} の事前生成に失敗:`, err);
      })
    );
  }

  await Promise.all(jobs);

  /**
   * 影と G バッファのバリアントを 1 フレームぶん走らせる。
   *
   * `forceCompilationAsync` は通常描画のバリアントしか作らない。影用の深度シェーダと
   * SSAO の G バッファ用シェーダは、実際にそのレンダーターゲットを 1 回描かないと
   * パイプラインが作られない。
   */
  await pumpFrames(engine, 2);

  return {
    ok: true,
    materials: seen.size,
    meshes: meshes.length,
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * フレームを n 回進める。
 *
 * **engine.step() を使う** (scene.render() を直接叩かない)。step は
 * beginFrame/endFrame を含み、WebGPU ではそこで submit と present が行われるため。
 * 直接 scene.render() を呼ぶと、コマンドが積まれるだけでパイプラインの生成が
 * 走らないことがある。
 */
function pumpFrames(engine, n) {
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      engine.step();
      if (++i >= n) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
