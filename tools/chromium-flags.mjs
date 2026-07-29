/**
 * headless Chromium に渡すフラグの SSOT。
 *
 * ## なぜ独立したモジュールなのか
 *
 * 最初これを `webgpu-probe.mjs` から export していたが、あのファイルは top-level で
 * プローブ本体を実行するスクリプトなので、**import しただけでプローブが走り
 * process.exit() してしまう**という事故が起きた。実行するスクリプトから値を
 * import しないこと。副作用のない定数だけをここに置く。
 *
 * ## フラグの意味
 *
 * `--enable-unsafe-webgpu` は「未実装機能を許可する」ではなく「ブロックリストや
 * 安定版制限を無視して WebGPU を露出する」フラグ。headless では実質必須。
 *
 * `--use-angle=metal` は macOS 専用。**Linux CI に移す際は vulkan 系に差し替える
 * 必要がある** — ここを直し忘れると CI でソフトウェアラスタライザに落ち、絵は
 * 出るのにピクセルが GPU 実行と一致しない、という最も厄介な失敗をする。
 */

/** macOS (Metal) 向け。 */
export const WEBGPU_FLAGS = [
  '--use-angle=metal',
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-zero-copy',
  '--disable-frame-rate-limit',
  '--force-color-profile=srgb',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--mute-audio',
];

/** Linux CI 向け。移行時はこちらを使うこと (未検証)。 */
export const WEBGPU_FLAGS_LINUX = [
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--disable-vulkan-surface',
  '--disable-vulkan-fallback-to-gl-for-testing',
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--disable-frame-rate-limit',
  '--force-color-profile=srgb',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--mute-audio',
];

/**
 * WebGPU を掴むには軽量な chromium-headless-shell ではなく full Chrome binary が
 * 要る。Playwright では channel:'chromium' がそれにあたる。
 */
export const CHROMIUM_CHANNEL = 'chromium';
