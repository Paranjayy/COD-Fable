#!/usr/bin/env node
/**
 * WebGPU headless feasibility gate — RUN THIS BEFORE TRUSTING ANY CAPTURE.
 *
 * 背景 / なぜ独立したツールなのか
 * -------------------------------------------------------------------------
 * このリポジトリで最も価値のある性質は「`tools/baseline.mjs` が bit-identical
 * で、`tools/imagediff.mjs` が exit code による決定的な pixel gate として機能
 * する」ことだった。最適化パスが "視覚的変化ゼロ" を *主張* ではなく *証明*
 * できたのは、この 2 つが揃っていたからに他ならない。
 *
 * WebGL2 → WebGPU の移行はこの土台を一段不安定にする:
 *
 *   1. 軽量な `chromium-headless-shell` では WebGPU アダプタが取れないことが
 *      ある。Playwright の `channel: 'chromium'`（= full Chrome binary）が要る。
 *   2. WebGPU の初期化は非同期 (`navigator.gpu.requestAdapter()`)。__READY__ が
 *      立つ前にシャッターを切ると空フレームを撮る。
 *   3. アダプタが *ソフトウェア* にフォールバックすると絵は出るが、GPU 実装と
 *      ピクセルが一致しない。しかも黙って成功するので最悪。
 *
 * したがって本体の移植より先に「2 回連続で bit-identical な PNG が撮れるか」を
 * 確かめる。ここが赤なら移行しない方がよい、というだけの重みがある判定。
 *
 * 使い方:
 *   node tools/webgpu-probe.mjs            # 既定 2 回撮って比較
 *   node tools/webgpu-probe.mjs --runs=3
 *   node tools/webgpu-probe.mjs --keep     # PNG を捨てずに残す
 *
 * exit 0 = WebGPU が使え、かつ決定的。exit 1 = どちらかが不成立。
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const RUNS = Number(args.runs ?? 2);
const W = Number(args.w ?? 640);
const H = Number(args.h ?? 360);
const KEEP = !!args.keep;

/**
 * headless で WebGPU を有効にするための Chromium フラグ。
 *
 * macOS は Metal 経由なので `--use-angle=metal`。Linux CI に持っていく場合は
 * `--use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface` に
 * 差し替える必要がある（このリポジトリの CI が Linux に移ったら要変更）。
 *
 * `--enable-unsafe-webgpu` は「未実装機能を許可する」ではなく「ブロックリスト
 * や安定版制限を無視して WebGPU を露出する」フラグ。headless では実質必須。
 */
export const WEBGPU_FLAGS = [
  '--use-angle=metal',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-zero-copy',
  '--disable-frame-rate-limit',
  '--force-color-profile=srgb',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--mute-audio',
];

/**
 * 描画内容は "決定的であること" だけを検証したいので、時間にもランダムにも
 * 依存しない固定の三角形＋グラデーションを WGSL で描く。ゲーム本体に依存しな
 * いので、本体が壊れていてもこのゲートは独立に判定できる。
 */
const PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>webgpu probe</title>
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style>
</head><body><canvas id="c"></canvas>
<script type="module">
window.__PROBE__ = { ok: false, reason: 'not started' };
const canvas = document.getElementById('c');
canvas.width = ${W}; canvas.height = ${H};

async function main() {
  if (!navigator.gpu) { window.__PROBE__ = { ok:false, reason:'navigator.gpu undefined' }; window.__DONE__=true; return; }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) { window.__PROBE__ = { ok:false, reason:'requestAdapter() returned null' }; window.__DONE__=true; return; }

  // アダプタ素性の記録。フォールバック（= CPU 実装）を掴んでいると絵は出るのに
  // GPU とピクセルが一致しないので、ここで必ず可視化しておく。
  const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const shader = device.createShaderModule({ code: \`
    struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
    @vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
      // フルスクリーン三角形。頂点バッファ不要 = 入力に一切依存しない。
      var p = array<vec2f, 3>(vec2f(-1.0,-3.0), vec2f(-1.0,1.0), vec2f(3.0,1.0));
      var o: VSOut;
      o.pos = vec4f(p[i], 0.0, 1.0);
      o.uv = p[i] * 0.5 + 0.5;
      return o;
    }
    @fragment fn fs(in: VSOut) -> @location(0) vec4f {
      // 円 + グラデーション。丸めの差が出れば縁のピクセルで検出できる。
      let d = distance(in.uv, vec2f(0.5, 0.5));
      let ring = smoothstep(0.34, 0.32, d);
      return vec4f(in.uv.x * 0.9, in.uv.y * 0.6 + ring * 0.4, ring, 1.0);
    }\` });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: shader, entryPoint: 'vs' },
    fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: ctx.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear', storeOp: 'store',
    }],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([enc.finish()]);

  // 提出しただけでは合成器に載ったことを保証できない。onSubmittedWorkDone を
  // 待ってから 2 回 rAF を回し、確実に present させてからシャッターを許可する。
  await device.queue.onSubmittedWorkDone();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  window.__PROBE__ = {
    ok: true,
    vendor: info.vendor ?? '?', architecture: info.architecture ?? '?',
    device: info.device ?? '?', description: info.description ?? '?',
    isFallbackAdapter: adapter.isFallbackAdapter ?? null,
    features: [...adapter.features].slice(0, 12),
    maxBufferSize: adapter.limits?.maxBufferSize ?? null,
  };
  window.__DONE__ = true;
}
main().catch(e => { window.__PROBE__ = { ok:false, reason: String(e && e.stack || e) }; window.__DONE__ = true; });
</script></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'webgpu-probe-'));
const htmlPath = join(dir, 'probe.html');
writeFileSync(htmlPath, PROBE_HTML);

const shots = [];
let probeInfo = null;
let failure = null;

try {
  for (let run = 0; run < RUNS; run++) {
    // 毎回ブラウザを立ち上げ直す。`baseline.mjs` がページを分離したのと同じ理由で、
    // プロセスを跨いで状態が漏れないことまで含めて検証したい。
    const browser = await chromium.launch({
      headless: true,
      channel: 'chromium', // headless-shell では WebGPU アダプタが取れない
      args: WEBGPU_FLAGS,
    });
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

    await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__DONE__ === true', null, { timeout: 30000 });

    const info = await page.evaluate('window.__PROBE__');
    probeInfo ??= info;
    if (!info.ok) {
      failure = `WebGPU unavailable: ${info.reason}\n${logs.join('\n')}`;
      await browser.close();
      break;
    }

    const buf = await page.screenshot({ type: 'png' });
    shots.push(buf);
    if (KEEP) writeFileSync(join(dir, `run${run}.png`), buf);
    await browser.close();
  }
} catch (e) {
  failure = String(e.stack ?? e);
}

let identical = null;
let maxDelta = null;
let changedPct = null;

if (!failure && shots.length >= 2) {
  const a = PNG.sync.read(shots[0]);
  let worstDelta = 0;
  let changed = 0;
  let total = 0;
  for (let k = 1; k < shots.length; k++) {
    const b = PNG.sync.read(shots[k]);
    if (a.width !== b.width || a.height !== b.height) {
      failure = `size mismatch between runs: ${a.width}x${a.height} vs ${b.width}x${b.height}`;
      break;
    }
    total = a.width * a.height;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2])
      );
      if (d > worstDelta) worstDelta = d;
      if (d > 0) changed++;
    }
  }
  maxDelta = worstDelta;
  changedPct = total ? +((changed / total) * 100).toFixed(4) : null;
  identical = worstDelta === 0;
}

if (!KEEP) rmSync(dir, { recursive: true, force: true });

const result = {
  ok: !failure && identical === true,
  webgpu: probeInfo?.ok ?? false,
  deterministic: identical,
  runs: RUNS,
  adapter: probeInfo?.ok
    ? {
        vendor: probeInfo.vendor,
        architecture: probeInfo.architecture,
        device: probeInfo.device,
        description: probeInfo.description,
        isFallbackAdapter: probeInfo.isFallbackAdapter,
        maxBufferSize: probeInfo.maxBufferSize,
      }
    : null,
  maxDelta,
  changedPct,
  ...(KEEP ? { artifacts: dir } : {}),
  ...(failure ? { error: failure } : {}),
};

console.log(JSON.stringify(result, null, 2));

// フォールバックアダプタは「動くが信用できない」ので明示的に警告する。
if (result.ok && probeInfo?.isFallbackAdapter) {
  console.error('\nWARNING: isFallbackAdapter=true — software rasteriser. Pixels will NOT match a GPU run.');
}

process.exit(result.ok ? 0 : 1);
