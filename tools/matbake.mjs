#!/usr/bin/env node
/**
 * Material forge bake gate.
 *
 * src/materials/bake-test.html を GPU-backed headless Chromium で開き、19 種の
 * 手続きサーフェスがすべて正しく焼けたかを判定する。
 *
 * **「WGSL のコンパイルが通った = 動いた」ではない**のがこのゲートの要点。WGSL は
 * コンパイルが通っても分岐に入り損ねて単色を返す、という失敗の仕方をするため、
 * 焼き上がりの分散・平均・法線の向きまで見る (判定基準は bake-test.js 側)。
 *
 *   node tools/matbake.mjs
 *   node tools/matbake.mjs --verbose   # ブラウザの console も出す
 *
 * exit 0 = 全サーフェス合格。
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';
import { WEBGPU_FLAGS, CHROMIUM_CHANNEL } from './chromium-flags.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5173);
const TIMEOUT = Number(args.timeout ?? 120000);

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
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) return p;
  }
  p.kill();
  throw new Error('vite failed to start');
}

const server = await ensureServer();
const browser = await chromium.launch({
  headless: true,
  channel: CHROMIUM_CHANNEL,
  args: WEBGPU_FLAGS,
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

let result = null;
let failure = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/src/materials/bake-test.html`, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT,
  });
  await page.waitForFunction('window.__DONE__ === true', null, { timeout: TIMEOUT });
  result = await page.evaluate('window.__BAKE_RESULT__');
} catch (e) {
  failure = String(e.message ?? e);
} finally {
  await browser.close();
  if (server) server.kill();
}

if (failure || !result?.ok || args.verbose) {
  // WGSL のコンパイルエラーはブラウザの console にしか出ないので、失敗時は必ず出す。
  console.error(logs.join('\n'));
}

console.log(JSON.stringify(result ?? { ok: false, error: failure }, null, 2));
process.exit(result?.ok ? 0 : 1);
