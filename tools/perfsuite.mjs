#!/usr/bin/env node
/**
 * 性能の「確定値」を出すためのラッパー。profile.mjs を N 回まわして集計する。
 *
 * ## なぜ単発の profile.mjs では足りないのか
 *
 * 移植時の測定はすべて 1 回きりで、そのときのマシンは load average 12〜19 (移植
 * エージェント、複数の Chromium、macOS の CoreGraphics/SkyLight/Virtualization) だった。
 * **同一設定の連続実行でヒッチ率が 2% と 33% の間で振れた**ため、README には
 * 「傾向であって確定値ではない」としか書けなかった。
 *
 * 数値そのものより先に必要なのは「**その数値が信頼できるかどうかの判定**」で、
 * それは 1 回の測定からは原理的に出てこない。このツールは:
 *
 *   1. 測定の前後で load average を取り、閾値を超えていたら結果に警告を付ける
 *   2. 同じ設定を N 回まわし、run 間のばらつき (相対四分位範囲) を出す
 *   3. ばらつきが閾値を超えたら **`stable: false` を返して exit 1** にする
 *
 * つまり「速い/遅い」ではなく「**測れている/測れていない**」をゲートにする。
 * 数字を出すこと自体は簡単で、危険なのは振れている数字を確定値として読むこと。
 *
 *   node tools/perfsuite.mjs --port=8080 --runs=5
 *   node tools/perfsuite.mjs --port=8080 --runs=5 --query=q=high  # 設定を変える
 */
import { spawn } from 'node:child_process';
import { loadavg, cpus } from 'node:os';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5173);
const RUNS = Number(args.runs ?? 5);
const NCPU = cpus().length;
/**
 * 「アイドル」の判定。1 分平均の load average を CPU 数で割った値。
 *
 * 1.0 = 論理コアが全部埋まっている状態。0.5 を超えると、測っているのはブラウザでは
 * なくマシンの混み具合になる。移植中の測定はここが 1.5〜2.4 だった。
 */
const LOAD_LIMIT = Number(args.loadLimit ?? 0.5);
/**
 * run 間のばらつきの上限 (相対四分位範囲 = IQR / 中央値)。
 * これを超えたら「この環境では確定値を出せない」と報告する。
 */
const RIQR_LIMIT = Number(args.riqrLimit ?? 0.15);

const ROOT = resolve(import.meta.dirname, '..');
const passthrough = ['w', 'h', 'dpr', 'frames', 'warmup', 'query', 'nofire', 'noai']
  .filter((k) => args[k] !== undefined)
  .map((k) => (args[k] === true ? `--${k}` : `--${k}=${args[k]}`));

const runOnce = () =>
  new Promise((done, fail) => {
    const p = spawn(
      process.execPath,
      [resolve(ROOT, 'tools/profile.mjs'), `--port=${PORT}`, ...passthrough],
      { cwd: ROOT }
    );
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return fail(new Error(`profile.mjs exit ${code}: ${err.slice(-400)}`));
      try {
        done(JSON.parse(out));
      } catch (e) {
        fail(new Error(`profile.mjs の出力が JSON ではない: ${out.slice(0, 200)}`));
      }
    });
  });

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const quantile = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
/** 相対四分位範囲。中央値が 0 のときは 0 を返す (0 除算を避ける)。 */
const riqr = (a) => {
  const m = median(a);
  return m === 0 ? 0 : +(((quantile(a, 0.75) - quantile(a, 0.25)) / m).toFixed(3));
};

const loadBefore = loadavg()[0] / NCPU;
const runs = [];
for (let i = 0; i < RUNS; i++) {
  const load = loadavg()[0] / NCPU;
  const r = await runOnce();
  runs.push({
    run: i + 1,
    loadAtStart: +load.toFixed(2),
    bootMs: r.bootMs,
    p50: r.frameTimeMs.p50,
    p95: r.frameTimeMs.p95,
    p99: r.frameTimeMs.p99,
    fpsP50: r.fps.p50,
    hitchPct: r.hitchPctOfFrames,
    compiledDuringPlay: r.programs.compiledDuringPlay,
    heapGrowthMb: r.heapMb.growth,
    errors: r.errors.length,
  });
  process.stderr.write(`run ${i + 1}/${RUNS} p50=${r.frameTimeMs.p50}ms hitch=${r.hitchPctOfFrames}%\n`);
}
const loadAfter = loadavg()[0] / NCPU;

const col = (k) => runs.map((r) => r[k]);
const summary = {};
for (const k of ['bootMs', 'p50', 'p95', 'p99', 'fpsP50', 'hitchPct']) {
  summary[k] = { median: median(col(k)), min: Math.min(...col(k)), max: Math.max(...col(k)), riqr: riqr(col(k)) };
}

/**
 * 判定。
 *
 * `compiledDuringPlay` だけは run をまたいで 0 でなければならない性質のもの
 * (実プレイ中のシェーダコンパイルは本家最大の性能問題だった) なので、ばらつきでは
 * なく絶対値で見る。
 */
const loadOk = loadBefore <= LOAD_LIMIT && loadAfter <= LOAD_LIMIT;
const stableP50 = summary.p50.riqr <= RIQR_LIMIT;
const stableHitch = summary.hitchPct.riqr <= RIQR_LIMIT || summary.hitchPct.max <= 1;
const noCompiles = col('compiledDuringPlay').every((n) => n === 0);
const stable = loadOk && stableP50 && stableHitch;

const notes = [];
if (!loadOk)
  notes.push(
    `load average / CPU が ${Math.max(loadBefore, loadAfter).toFixed(2)} (上限 ${LOAD_LIMIT})。` +
      `測っているのはブラウザではなくマシンの混み具合。他の作業を止めてから測り直すこと。`
  );
if (!stableP50) notes.push(`p50 の run 間ばらつき rIQR=${summary.p50.riqr} が上限 ${RIQR_LIMIT} を超えている。`);
if (!stableHitch) notes.push(`ヒッチ率の run 間ばらつき rIQR=${summary.hitchPct.riqr} が上限 ${RIQR_LIMIT} を超えている。`);
if (!noCompiles)
  notes.push(`**実プレイ中にシェーダがコンパイルされている** (${col('compiledDuringPlay').join(',')})。prewarm の退行。`);

console.log(
  JSON.stringify(
    {
      stable,
      confidence: stable ? 'この環境の確定値として報告してよい' : '確定値として報告してはいけない',
      cpus: NCPU,
      load: { beforeNorm: +loadBefore.toFixed(2), afterNorm: +loadAfter.toFixed(2), limit: LOAD_LIMIT },
      runs,
      summary,
      noShaderCompilesDuringPlay: noCompiles,
      notes,
    },
    null,
    2
  )
);

process.exit(stable ? 0 : 1);
