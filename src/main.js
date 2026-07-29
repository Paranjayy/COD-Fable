import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { RenderSystem } from './render/index.js';
import { PhysicsSystem } from './physics/index.js';
import { WorldSystem } from './world/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
/**
 * 決定的シャッター用のロックステップ。
 *
 * engine 自身はフレームを回さず、ドライバが window.__PUMP__ で正確に N フレーム
 * 進める。opt-in なのは、実フレームレートを測るツール (tools/profile.mjs) では
 * ループを自走させる必要があるため。詳細は src/dev/shots.js のコメント。
 */
const lockstep = capture && params.get('lockstep') === '1';

const config = createConfig({
  quality: params.get('q') ?? 'ultra',
  deterministic: capture,
  /**
   * バックエンドは既定で自動 (WebGPU → 駄目なら WebGL2)。
   *
   * **キャプチャ時は必ず明示すること。** バックエンドが違えばピクセルは当然一致
   * しないので、自動フォールバックが黙って起きた状態でベースラインを撮ると
   * 「最適化で絵が変わった」と誤診する。tools/capture.mjs は常に ?backend=webgpu を
   * 付ける。
   */
  backend: params.get('backend') ?? undefined,
});

/**
 * 切り分け用のフラグ。品質プリセットの個々の機能を URL から落とせる。
 *
 * ポストプロセスは互いに影響するうえ、WebGPU のエラーは「どのパスが原因か」を
 * 教えてくれないことが多い。プリセット単位でしか切り替えられないと二分探索が
 * できないため、機能ごとの穴を開けてある。
 */
for (const [key, flag] of [
  ['clustered', 'clusteredLights'],
  ['taa', 'taa'],
  ['gtao', 'gtao'],
  ['mblur', 'motionBlur'],
  ['bloom', 'bloom'],
]) {
  const v = params.get(key);
  if (v === '0') config.q[flag] = false;
  else if (v === '1') config.q[flag] = true;
}

// 切り分け用: ?post=0 でポストプロセスを丸ごと外す。
if (params.get('post') === '0') config.post = false;

const canvas = document.getElementById('game');

// WebGPU の初期化が非同期なので、Engine は静的ファクトリで作る。
const engine = await Engine.create({ canvas, config });

/**
 * 登録順は無関係 — Registry が static deps でトポロジカルソートする。
 *
 * 依存関係:
 *   materials → (なし)
 *   sky       → (なし)
 *   render    → sky   (太陽の DirectionalLight が無いと CSM を作れない)
 *   physics   → (なし)
 *   world     → materials, physics, render
 *   player    → physics, world, render
 *   weapons   → materials, physics
 *   fx        → render, materials, physics
 *   ui        → render
 *   audio     → (なし)  physics は実行時に peek するだけなので依存にしない。
 *                       AudioContext はユーザー操作まで作られないので init は常に成功する。
 */
engine
  .add(MaterialSystem)
  .add(SkySystem)
  .add(RenderSystem)
  .add(PhysicsSystem)
  .add(WorldSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(UiSystem)
  .add(AudioSystem);

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  window.__BOOT_ERROR__ = String(err.stack ?? err.message);
  window.__READY__ = true; // ハーネスがタイムアウトせず失敗を報告できるようにする
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

engine.start();

/**
 * キャプチャハーネスとのハンドシェイク。**フレームが実際に landed してから** ready
 * を立てる。
 *
 * BOOT_FRAMES は意図的に「フレーム数」であって rAF レースではない。ロックステップでは
 * engine が自分のループを持たないので、この数だけ手で送ってから __READY__ を立てる。
 * したがってショットは常に engine frame 3 で適用され、boot が何秒かかろうと変わらない。
 */
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;
window.__BACKEND__ = engine.backend;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
