#!/usr/bin/env node
/**
 * Gameplay profiler — reproduces the conditions a real player hits, which the
 * static-camera capture harness completely misses:
 *
 *  - real device pixel ratio (Retina => 1.5x internal scale, ~3.3 MP not 2.07 MP)
 *  - a moving camera (forces new shadow cascades, new frusta, streaming)
 *  - firing (particles, decals, tracers, muzzle light, audio)
 *  - AI active (skinned meshes, ragdolls, pathfinding)
 *
 * Reports the frame-time DISTRIBUTION and every hitch, because a median frame
 * time hides exactly the stalls that make a game feel broken. Also tracks WebGL
 * program count per frame — a jump in programs on the same frame as a hitch is
 * a shader compilation stall, the classic cause of Three.js hitching.
 *
 *   node tools/profile.mjs --port=8080 --dpr=2 --w=1512 --h=982
 */
import { chromium } from 'playwright';
import { WEBGPU_FLAGS, CHROMIUM_CHANNEL } from './chromium-flags.mjs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const PORT = Number(args.port ?? 8080);
const W = Number(args.w ?? 1512);
const H = Number(args.h ?? 982);
const DPR = Number(args.dpr ?? 2);
const FRAMES = Number(args.frames ?? 900);
/**
 * `--nofire` で発砲を止める。
 *
 * ヒッチの原因が「描画側」なのか「発砲に伴う処理 (弾道・FX・薬莢の剛体生成)」なのかを
 * 切り分けるため。中央値のフレーム時間だけを見ていると、この区別は絶対に付かない。
 */
const NOFIRE = !!args.nofire;
/** `--noai` で AI の交戦ステージを起動しない。AI 起因のヒッチを切り分けるため。 */
const NOAI = !!args.noai;

const browser = await chromium.launch({
  headless: true,
  // WebGPU を掴むには軽量な headless-shell ではなく full Chrome binary が要る。
  channel: CHROMIUM_CHANNEL,
  args: WEBGPU_FLAGS,
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const t0 = Date.now();
const EXTRA = args.query ? `?${args.query}` : '';
await page.goto(`http://127.0.0.1:${PORT}/${EXTRA}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
const bootMs = Date.now() - t0;

// Boot-phase breakdown: how much of that boot was spent where.
const bootMarks = await page.evaluate(() =>
  performance.getEntriesByType('measure').map((m) => ({ name: m.name, ms: +m.duration.toFixed(1) }))
    .sort((a, b) => b.ms - a.ms).slice(0, 25));

/**
 * 内部解像度の実測。
 *
 * Three 版は WebGL の drawingBuffer を直接読んでいたが、Babylon では
 * `engine.getRenderWidth()/getRenderHeight()` が実際に描いている解像度を返す。
 * **CSS ピクセルではなく内部解像度を見ること** — README に記録された
 * 「静止カメラで 94fps、実プレイで 12fps」の誤測定は、Retina の内部解像度
 * (3.34 MP) を 2.07 MP と思い込んでいたことが一因だった。
 */
const internal = await page.evaluate(() => {
  const eng = window.__ENGINE__;
  const b = eng.babylon;
  const w = b.getRenderWidth();
  const h = b.getRenderHeight();
  return {
    backend: eng.backend,
    hardwareScaling: b.getHardwareScalingLevel(),
    drawingBuffer: [w, h],
    megapixels: +((w * h) / 1e6).toFixed(2),
    quality: eng.config.quality,
    renderScale: eng.config.q.renderScale,
  };
});

// Enable player control and run a scripted gameplay sequence while sampling.
await page.evaluate((noai) => {
  window.__NOAI__ = noai;
  const e = window.__ENGINE__;
  e.input.enabled = true; e.input.frozen = false;
  e.ctx.peek('player')?.setControlEnabled?.(true);
  if (!window.__NOAI__) e.ctx.peek('ai')?.debugStage?.('firefight');
}, NOAI);

const result = await page.evaluate(({ FRAMES, NOFIRE }) => new Promise((done) => {
  const e = window.__ENGINE__;
  const samples = [];
  let last = performance.now(), i = 0;

  const tick = () => {
    const now = performance.now();
    const dt = now - last; last = now;

    // Drive gameplay: orbit the view, walk, and fire in bursts.
    const t = i / 60;
    e.camera.rotation.y += 0.006;
    const mv = e.ctx.peek('player');
    if (mv) { try { e.input.down.add('KeyW'); } catch {} }
    if (!NOFIRE && i % 90 < 30) { e.input.down.add('Mouse0'); } else { e.input.down.delete('Mouse0'); }

    /**
     * `progs` は「コンパイル済みシェーダ (Effect) の本数」。
     *
     * README に記録された最大の性能問題は「フレーム中に 34〜35 本のシェーダが
     * 遅延コンパイルされ 728〜1236ms 停止する」ことだった。**ヒッチと同じフレームで
     * この数が跳ねていれば、それはシェーダコンパイル由来**と断定できる。
     * 中央値のフレーム時間だけを見ていると絶対に見つからない類の問題なので、
     * 必ずフレームごとに記録する。
     *
     * Babylon では engine._compiledEffects がコンパイル済み Effect のマップ。
     * WebGPU ではさらにパイプライン生成のコストが乗るが、その大半は Effect 生成に
     * 紐づくのでこの指標で追える。
     */
    samples.push({
      i, dt,
      progs: Object.keys(e.babylon._compiledEffects ?? {}).length,
      calls: e.babylon._drawCalls?.current ?? 0,
      tris: (e.scene.getActiveIndices?.() ?? 0) / 3,
      meshes: e.scene.getActiveMeshes?.().length ?? 0,
      texs: e.babylon._internalTexturesCache?.length ?? 0,
      heap: performance.memory ? performance.memory.usedJSHeapSize >> 20 : 0,
      // ?systime=1 のときだけ埋まる。ヒッチの内訳を名指しするための内訳。
      sys: e.sysTime ? { ...e.sysTime } : null,
    });

    if (++i >= FRAMES) return done(samples);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), { FRAMES, NOFIRE });

// Discard the first 60 frames: control handover and the first shadow-cascade fit
// are one-time costs, not steady state.
//
// `--warmup=0` keeps them, which is how you see the COLD first-load experience:
// a lazily-compiled program lands in exactly those discarded frames, so the
// default view is blind to the stall the pre-warm exists to remove.
const WARMUP = Number(args.warmup ?? 60);
const warm = result.slice(WARMUP);
const dts = warm.map((s) => s.dt).sort((a, b) => a - b);
const q = (p) => +dts[Math.min(dts.length - 1, Math.floor(dts.length * p))].toFixed(2);
const med = q(0.5);

const hitches = warm
  .filter((s) => s.dt > Math.max(2 * med, med + 8))
  .map((s, n, arr) => {
    const prev = warm[warm.indexOf(s) - 1];
    return {
      frame: s.i, ms: +s.dt.toFixed(1),
      // ヒッチのフレームで最も時間を食ったサブシステム上位 3 つ。
    top: s.sys
      ? Object.entries(s.sys)
          .filter(([k]) => !k.startsWith('_fixed.steps'))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, v]) => `${k}=${(+v).toFixed(1)}ms`)
      : null,
    progDelta: prev ? s.progs - prev.progs : 0,
      geoDelta: prev ? s.geos - prev.geos : 0,
      texDelta: prev ? s.texs - prev.texs : 0,
    };
  });

const first = warm[0], lastS = warm[warm.length - 1];
console.log(JSON.stringify({
  bootMs,
  bootMarks,
  internal,
  frames: warm.length,
  frameTimeMs: { p1: q(0.01), p50: med, p90: q(0.9), p95: q(0.95), p99: q(0.99), max: q(1) },
  fps: { p50: +(1000 / med).toFixed(0), p95: +(1000 / q(0.95)).toFixed(0), p99: +(1000 / q(0.99)).toFixed(0) },
  hitchCount: hitches.length,
  hitchPctOfFrames: +((hitches.length / warm.length) * 100).toFixed(2),
  worstHitches: hitches.sort((a, b) => b.ms - a.ms).slice(0, 15),
  programs: { start: first.progs, end: lastS.progs, compiledDuringPlay: lastS.progs - first.progs },
  resources: { geosStart: first.geos, geosEnd: lastS.geos, texStart: first.texs, texEnd: lastS.texs },
  heapMb: { start: first.heap, end: lastS.heap, growth: lastS.heap - first.heap },
  drawCalls: { min: Math.min(...warm.map(s=>s.calls)), max: Math.max(...warm.map(s=>s.calls)) },
  errors: errs.slice(0, 6),
}, null, 2));

await browser.close();
