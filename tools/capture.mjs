#!/usr/bin/env node
/**
 * Deterministic screenshot harness for the game.
 *
 * Boots vite (if not already up), opens the page in GPU-backed Chromium,
 * waits for `window.__READY__`, optionally runs a named "shot" defined in
 * src/dev/shots.js, then writes a PNG.
 *
 * Usage:
 *   node tools/capture.mjs --shot=hero --out=shots/hero.png
 *   node tools/capture.mjs --shot=hero --out=shots/hero.png --w=2560 --h=1440
 *   node tools/capture.mjs --list
 */
import { chromium } from 'playwright';
import { WEBGPU_FLAGS, CHROMIUM_CHANNEL } from './chromium-flags.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5173);
const W = Number(args.w ?? 1920);
const H = Number(args.h ?? 1080);
const SHOT = args.shot ?? 'default';
const OUT = resolve(args.out ?? `shots/${SHOT}.png`);
const TIMEOUT = Number(args.timeout ?? 90000);
// Frames to render before capture: lets TAA converge, streaming settle, LOD pick.
const SETTLE = Number(args.settle ?? 90);
/**
 * URL に足す追加クエリ (例: --query=q=low&clustered=0)。
 *
 * 機能の切り分けに要る。baseline.mjs は元から持っていたが capture.mjs には無く、
 * 「フラグを足したのに効いていない」ことに気付かないまま切り分けを進める事故が
 * 起きたので揃えた。
 */
const QUERY = typeof args.query === 'string' ? `&${args.query}` : '';

/**
 * **最初の GPU 検証エラーだけを抜き出して先頭に出す。**
 *
 * ## なぜ必要か — このハーネスの欠陥で数時間を溶かした
 *
 * WebGPU では 1 つの不正パイプラインを SetPipeline した時点で、**そのフレームの
 * コマンドバッファ全体が invalid になり Queue.Submit ごと捨てられる**。結果として
 * 「1 次エラー 1 件」のあとに「invalid due to a previous error」が数十件続く。
 *
 * このツールは以前 `logs.slice(-60)` で **末尾だけ**を出していたため、表示されるのは
 * 巻き添えエラーばかりで、**原因を名指しする 1 次エラーが必ず流れて消えていた**。
 *
 * 実例: パーティクルで画面全体が黒くなる不具合。1 次エラーは
 *
 *   Vertex buffer count (10) exceeds the maximum number of vertex buffers (8).
 *
 * だったが、表示されるのは「PostProcessRTT-highlights の RenderPipeline が不正」という
 * **まったく別のパスを指す巻き添え**だけだった。そのため「ポストプロセスとの相互作用」
 * という誤った仮説を長く追うことになった。
 *
 * さらに **Babylon は uncaptured error を console.warn で流す** (error ではない) ので、
 * type で error だけを拾うフィルタでは捕まらない。
 */
function firstGpuError(all) {
  const primary = all.find(
    (l) => /GPUValidationError|Vertex buffer count|exceeds the maximum|Error while parsing WGSL/i.test(l)
        && !/due to a previous error/i.test(l)
  );
  if (!primary) return '';
  return [
    '',
    '=== FIRST GPU ERROR (根本原因。以降の "due to a previous error" は巻き添え) ===',
    primary,
    '='.repeat(70),
    '',
  ].join('\n');
}

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const root = resolve(import.meta.dirname, '..');
  const p = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    detached: false,
    // No hot reload: a file saved mid-run would reload the page under playwright.
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) return p;
  }
  p.kill();
  throw new Error('vite failed to start');
}

const server = await ensureServer();

const browser = await chromium.launch({
  headless: true,
  // WebGPU を掴むには軽量な headless-shell ではなく full Chrome binary が要る。
  channel: CHROMIUM_CHANNEL,
  args: WEBGPU_FLAGS,
});

const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

let failed = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&backend=webgpu&shot=${encodeURIComponent(SHOT)}${QUERY}`, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT,
  });

  // Engine sets window.__READY__ = true once assets are loaded and first frame drawn.
  await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });

  if (args.list) {
    const shots = await page.evaluate('Object.keys(window.__SHOTS__ ?? {})');
    console.log(JSON.stringify(shots, null, 2));
  } else {
    // Apply the shot (camera pose, time of day, weapon state, ...).
    const applied = await page.evaluate(
      ({ s, settle }) =>
        window.__APPLY_SHOT__ ? window.__APPLY_SHOT__(s, { grabFrame: settle }) : 'no-shot-api',
      { s: SHOT, settle: SETTLE }
    );
    logs.push(`[shot] ${JSON.stringify(applied)}`);

    // Pump deterministic frames so temporal effects converge.
    await page.evaluate(
      (n) =>
        new Promise((done) => {
          let i = 0;
          const tick = () => (++i >= n ? done() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
      SETTLE
    );

    mkdirSync(dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT, type: 'png' });

    const info = await page.evaluate('window.__RENDER_INFO__ ?? null');
    console.log(JSON.stringify({ ok: true, out: OUT, shot: SHOT, w: W, h: H, info }, null, 2));
  }
} catch (e) {
  failed = e;
} finally {
  // 実際に使われたバックエンドを記録する。WebGL2 に落ちたベースラインと WebGPU の
  // ベースラインを取り違えると「最適化で絵が変わった」と誤診するため。
  const gpu = await page
    .evaluate(async () => {
      const backend = window.__BACKEND__ ?? 'unknown';
      let adapter = 'n/a';
      if (navigator.gpu) {
        const a = await navigator.gpu.requestAdapter();
        const info = a?.info ?? {};
        adapter = `${info.vendor ?? '?'}/${info.architecture ?? '?'}`;
      }
      return `${backend} (${adapter})`;
    })
    .catch(() => 'n/a');
  if (failed || args.verbose) {
    console.error('GPU:', gpu);
    console.error(firstGpuError(logs));
    console.error(logs.slice(-60).join('\n'));
  }
  await browser.close();
  if (server) server.kill();
}

if (failed) {
  console.error(JSON.stringify({ ok: false, error: failed.message }));
  process.exit(1);
}
