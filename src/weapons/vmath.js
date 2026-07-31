import { Quaternion } from '@babylonjs/core/Maths/math.vector.js';

/**
 * Babylon 数学の補助 — Three の Euler 規約との橋渡し。
 *
 * defs.js / models/*.js / clips.js の回転値はすべて Three の Euler 'XYZ'
 * (行列 R = Rx·Ry·Rz、つまり **rz が最初にベクトルへ掛かる**) で作られている。
 * Babylon の Quaternion.FromEulerAngles は YXZ なので、そのまま渡すと
 * サムの付け根や ADS カントが別の姿勢になる。ここの 2 関数だけを必ず通すこと。
 */

/** Three の Euler 'XYZ' → クォータニオン (Three.Quaternion.setFromEuler と同式)。 */
export function quatXYZToRef(x, y, z, out) {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  out.x = s1 * c2 * c3 + c1 * s2 * s3;
  out.y = c1 * s2 * c3 - s1 * c2 * s3;
  out.z = c1 * c2 * s3 + s1 * s2 * c3;
  out.w = c1 * c2 * c3 - s1 * s2 * s3;
  return out;
}

/**
 * クォータニオン → Euler 'YXZ' の (pitch=x, yaw=y)。
 * viewmodel の lag レイヤがカメラの角速度を測るのに使う (Three 版と同じ抽出)。
 */
export function yawPitchFromQuat(q, out) {
  const { x, y, z, w } = q;
  // 回転行列の該当要素だけ計算する (R = 標準のクォータニオン→行列)。
  const m23 = 2 * (y * z - w * x); // row2 col3
  const m13 = 2 * (x * z + w * y);
  const m33 = 1 - 2 * (x * x + y * y);
  out.pitch = Math.asin(-Math.min(1, Math.max(-1, m23)));
  out.yaw = Math.abs(m23) < 0.99999 ? Math.atan2(m13, m33) : 0;
  return out;
}

/**
 * TransformNode に Three 'XYZ' Euler を適用する。rotationQuaternion を立てるので
 * 以後この node の .rotation (Babylon YXZ) は使わないこと。
 */
export function setEulerXYZ(node, x, y, z) {
  if (!node.rotationQuaternion) node.rotationQuaternion = new Quaternion();
  quatXYZToRef(x, y, z, node.rotationQuaternion);
  return node;
}
