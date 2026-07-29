/**
 * MATERIAL FORGE BAKE TEST — WGSL が本当にコンパイルされ、焼けるかを確認する。
 *
 * ## なぜ独立したページなのか
 *
 * WGSL は 2023 年以降の言語で学習データが薄く、**このプロジェクトで最も
 * コンパイルエラーを出しやすい箇所**。ゲーム本体が起動するようになってから
 * 「実は 19 サーフェスのうち 3 つが黙って黒だった」と気付くのは最悪なので、
 * materials だけを最小構成で起動して検証できる経路を用意しておく。
 *
 * 検証しているのは 3 点:
 *   1. 3 本のシェーダが WGSL としてコンパイルできるか (エラーは console に出る)
 *   2. 19 サーフェスすべてが「真っ黒でも真っ白でもない」絵になっているか
 *   3. albedo が README の品質バー (0.02-0.9) の範囲に収まっているか
 *
 * 2 が重要。WGSL はコンパイルが通っても、分岐に入り損ねて単色が出るだけ、という
 * 失敗の仕方をする。**コンパイル成功を「動いた」と読み替えない**ための検査。
 *
 * 実行: node tools/matbake.mjs
 */
import { Engine as BabylonEngine } from '@babylonjs/core/Engines/engine.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { MaterialSystem } from './index.js';
import { SURFACE_KEYS, LIBRARY } from './library.js';

const logEl = document.getElementById('log');
const lines = [];
const log = (s) => {
  lines.push(s);
  logEl.textContent = lines.join('\n');
};

async function main() {
  const canvas = document.getElementById('game');

  let engine;
  let backend;
  if (await WebGPUEngine.IsSupportedAsync) {
    engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false });
    await engine.initAsync();
    backend = 'webgpu';
  } else {
    engine = new BabylonEngine(canvas, false, {}, false);
    backend = 'webgl2';
  }
  log(`backend: ${backend}`);

  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;

  // MaterialSystem が必要とする最小の ctx。engine 全体を起こさずに済ませる。
  const ctx = {
    scene,
    backend,
    config: { q: { anisotropy: 8 } },
  };

  const sys = new MaterialSystem();
  const t0 = performance.now();
  await sys.init(ctx);
  const bakeMs = performance.now() - t0;
  log(`baked in ${bakeMs.toFixed(0)}ms, degraded=${sys.degraded}`);

  const results = [];
  for (const name of SURFACE_KEYS) {
    const set = sys.textures.get(name);
    if (!set) {
      results.push({ name, ok: sys.degraded, reason: 'no texture (degraded mode)' });
      continue;
    }
    const stats = await sampleStats(set.albedo);
    const nrm = await sampleStats(set.normal);
    const orm = await sampleStats(set.orm);

    /**
     * 判定基準。
     *
     * ## 「分岐に入ったか」は height で見る。albedo で見てはいけない
     *
     * 最初 albedo の標準偏差 (8bit 絶対値) で単色判定していたが、`rubber`
     * (タイヤゴム、albedo ≈ 0.024) が誤検出された。**暗い素材ほど 8bit での
     * 分散が小さくなる**ので、絶対値のしきい値は暗い素材を不当に落とす。
     *
     * height はサーフェスの明るさと独立で、しかも 19 分岐すべてが必ず h を
     * 変調している。よって「シェーダの分岐に入ったか」の指標としては height の
     * 分散のほうが正しい。
     *
     * ## 値域は線形 8bit で見る
     *
     * テクスチャは gammaSpace=false (線形) で焼いてあるので、格納値はそのまま
     * 線形値 x255。README の品質バー「Albedo in 0.02-0.9」はしたがって
     * 5..230 に対応する。
     */
    const branchNotReached = stats.stdevA < 2.0;
    const flat = branchNotReached && stats.stdev < 1.0;
    const tooDark = stats.mean < 5;
    const tooBright = stats.mean > 230;
    // 法線の B (=Z) が中央値を大きく下回るのは、法線が寝ている = Sobel が効いて
    // いない兆候。逆に 255 に張り付くのは起伏がゼロ。
    //
    // ただし library 側で expectFlat を宣言したサーフェス (ガラス) は平坦が正しい。
    // ゲートを緩めるのではなく例外を宣言させることで、残りの検査は厳格に保つ。
    const expectFlat = LIBRARY[name]?.expectFlat === true;
    const normalBroken = nrm.meanB < 100 || (!expectFlat && nrm.meanB > 254.5);

    results.push({
      name,
      ok: !flat && !tooDark && !tooBright && !normalBroken,
      albedoMean: +stats.mean.toFixed(1),
      albedoStdev: +stats.stdev.toFixed(2),
      heightStdev: +stats.stdevA.toFixed(2),
      normalMeanB: +nrm.meanB.toFixed(1),
      ormMeanG: +orm.meanG.toFixed(1),
      ...(flat ? { fail: 'flat — shader branch likely not reached (height variance ~0)' } : {}),
      ...(tooDark ? { fail: `albedo too dark (linear ${(stats.mean / 255).toFixed(3)} < 0.02)` } : {}),
      ...(tooBright ? { fail: `albedo too bright (linear ${(stats.mean / 255).toFixed(3)} > 0.9)` } : {}),
      ...(normalBroken ? { fail: 'normal map looks wrong (Sobel not applied?)' } : {}),
    });
  }

  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    log(
      `${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(16)} ` +
        `albedo μ=${r.albedoMean ?? '-'} σ=${r.albedoStdev ?? '-'} ` +
        `height σ=${r.heightStdev ?? '-'} normalB=${r.normalMeanB ?? '-'} rough=${r.ormMeanG ?? '-'}` +
        (r.fail ? `  <-- ${r.fail}` : '')
    );
  }

  window.__BAKE_RESULT__ = {
    ok: bad.length === 0,
    backend,
    degraded: sys.degraded,
    bakeMs: Math.round(bakeMs),
    count: results.length,
    failures: bad,
    results,
  };
  window.__DONE__ = true;
  log(`\n=== ${bad.length === 0 ? 'ALL OK' : `${bad.length} FAILURES`} ===`);
}

/** テクスチャを読み戻して統計を取る。遅いが検証用なので構わない。 */
async function sampleStats(tex) {
  const buf = await tex.readPixels();
  const d = new Uint8Array(buf.buffer ?? buf);
  let sum = 0;
  let sumSq = 0;
  let sumA = 0;
  let sumASq = 0;
  let sumB = 0;
  let sumG = 0;
  const px = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += lum;
    sumSq += lum * lum;
    sumA += d[i + 3];
    sumASq += d[i + 3] * d[i + 3];
    sumB += d[i + 2];
    sumG += d[i + 1];
  }
  const mean = sum / px;
  const meanA = sumA / px;
  return {
    mean,
    stdev: Math.sqrt(Math.max(0, sumSq / px - mean * mean)),
    stdevA: Math.sqrt(Math.max(0, sumASq / px - meanA * meanA)),
    meanB: sumB / px,
    meanG: sumG / px,
  };
}

main().catch((e) => {
  log(`FATAL: ${e.stack ?? e}`);
  window.__BAKE_RESULT__ = { ok: false, error: String(e.stack ?? e) };
  window.__DONE__ = true;
});
