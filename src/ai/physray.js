/**
 * AI — physics レイキャストの薄い橋渡し。
 *
 * Three 版の physics は `raycast(x, y, z, dx, dy, dz, maxDist, mask)` の
 * 8 引数形だったが、Babylon 版 (src/physics/index.js) は
 * `raycast(origin, dir, maxDist, mask)` のオブジェクト形。ai 側の呼び出しは
 * nav の格子ビルド (~10 万回) を筆頭に大量にあるので、毎回オブジェクトを
 * 作らずモジュールスコープのスクラッチ 2 個を使い回す。
 *
 * 罠: 戻り値の Hit は physics のリングプール (深さ 64) 由来。**すぐ読むか
 * コピーする**こと。ここで包み直したりキャッシュしたりしない。
 */

const _origin = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };

/** 8 引数形のレイキャスト。Hit を返す (リングプール — すぐ読むこと)。 */
export function ray(phys, x, y, z, dx, dy, dz, maxDist, mask) {
  _origin.x = x;
  _origin.y = y;
  _origin.z = z;
  _dir.x = dx;
  _dir.y = dy;
  _dir.z = dz;
  return phys.raycast(_origin, _dir, maxDist, mask);
}

/** 8 引数形の any ヒット判定。 */
export function rayAny(phys, x, y, z, dx, dy, dz, maxDist, mask) {
  _origin.x = x;
  _origin.y = y;
  _origin.z = z;
  _dir.x = dx;
  _dir.y = dy;
  _dir.z = dz;
  return phys.raycastAny(_origin, _dir, maxDist, mask);
}
