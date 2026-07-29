import HavokPhysics from '@babylonjs/havok';
// Vite に wasm を asset として解決させる。`?url` を付けないと Havok のローダが
// 相対パスで fetch しようとして dev / build のどちらかで必ず 404 になる。
import havokWasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url';

/**
 * Havok WASM のロードはプロセスに 1 回だけ行う。
 *
 * HMR や、キャプチャハーネスが同一ページで複数回 init する経路で二重ロードすると
 * WASM インスタンスが 2 つできて、片方の world に追加したボディがもう片方の
 * raycast に引っかからない — 「たまに弾が壁を抜ける」という再現性の低い不具合に
 * なるため、必ずこのモジュールスコープのキャッシュを経由する。
 */
let _havokPromise = null;

export function loadHavok() {
  _havokPromise ??= HavokPhysics({ locateFile: () => havokWasmUrl });
  return _havokPromise;
}
