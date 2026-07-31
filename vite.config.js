import { defineConfig } from 'vite';

export default defineConfig({
  // Bind IPv4 explicitly: the default `localhost` binds ::1 only on macOS,
  // which the capture harness (127.0.0.1) cannot reach.
  // `hmr: false` when the capture harness owns the server (OW_NO_HMR=1): a file
  // saved by a concurrently-working agent otherwise reloads the page mid-capture
  // and playwright fails with "Execution context was destroyed".
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: process.env.OW_NO_HMR ? false : undefined,
  },
  preview: { host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4096 },
  /**
   * Babylon を依存最適化 (pre-bundle) の対象から外す。
   *
   * Babylon 9 はシェーダのチャンクを **動的 import** で遅延ロードする
   * (例: shadowMapFragmentSoftTransparentShadow)。esbuild の pre-bundle を通すと
   * この動的 import が解決できず「Failed to fetch dynamically imported module」で
   * 落ちる。除外すると dev の初回起動は遅くなるが、動的 import が素直に解決される。
   */
  optimizeDeps: {
    exclude: ['@babylonjs/core', '@babylonjs/materials', '@babylonjs/havok'],
  },
  // Large binary game assets served verbatim.
  assetsInclude: ['**/*.ktx2', '**/*.hdr', '**/*.exr', '**/*.bin', '**/*.glb'],
});
