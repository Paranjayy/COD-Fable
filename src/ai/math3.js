/**
 * AI — Three.js 互換の最小 math ライブラリ (Babylon 移植の要)。
 *
 * ## なぜ Babylon の math に書き換えず、互換 shim を挟むのか
 *
 * ai サブシステムの 8k 行のうち、Three 依存の大半は Vector3 / Quaternion /
 * Matrix4 の**メソッド名**である (geo.js のロフト、parts.js の 1,000 行の装備
 * ジオメトリ、animator.js の 3 系統の IK、nav.js の A*)。Babylon の math は
 * 同じ概念を別名 (`subtractInPlace` / `rotateByQuaternionToRef` …) と別のチェーン
 * 規約で提供するため、素直に書き換えると数千箇所の機械的リネームになり、
 * 1 箇所でも取り違えると「なんとなく動くが姿勢が数度ズレる」類の、絵からしか
 * 発見できないバグになる。
 *
 * この shim は ai が実際に使う Three API の**部分集合だけ**を、Three と同じ
 * セマンティクス (列優先 elements 配列、mutable チェーン、'XYZ'/'YXZ' Euler) で
 * 実装する。これにより rig / geo / parts / weapon / animator / nav / squad は
 * import の 1 行差し替えだけで移植できる。
 *
 * ## Babylon との境界
 *
 * - この shim の Vector3/Quaternion は素の {x,y,z(,w)} フィールドを持つので、
 *   physics API (`raycast(origin, dir, ...)` 等) や events のペイロードには
 *   そのまま渡せる (受け手は .x/.y/.z しか読まない)。
 * - Babylon の Matrix (メモリ上は行優先だが translation が m[12..14] に載る) と
 *   Three の列優先 elements は**同じメモリレイアウト**になる。ボーン行列を
 *   Babylon の Skeleton に書き込むときはこの一致を利用して elements を直接
 *   copyFrom する (agent.js 参照)。
 *
 * ## 罠 (後続の作業者へ)
 *
 * - `multiply(q)` は this = this * q、`premultiply(q)` は this = q * this。
 *   Three と同じ。Babylon の `multiplyInPlace` とは**引数の側が逆**なので、
 *   ここのコードを Babylon 流に「直そう」としないこと。
 * - Euler の既定 order は 'XYZ' (Three と同じ)。animator は 'XYZ'、weapon.js は
 *   'YXZ' を使う。
 * - すべて boot 時 or プリアロケート済みオブジェクトの mutate で使われる。
 *   ここに新しいメソッドを足すときも per-frame アロケーションを持ち込まない。
 */

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  setScalar(s) {
    this.x = s;
    this.y = s;
    this.z = s;
    return this;
  }

  setY(y) {
    this.y = y;
    return this;
  }

  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  clone() {
    return new Vector3(this.x, this.y, this.z);
  }

  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addVectors(a, b) {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    return this;
  }

  addScaledVector(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  subVectors(a, b) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  divideScalar(s) {
    return this.multiplyScalar(1 / s);
  }

  negate() {
    return this.multiplyScalar(-1);
  }

  length() {
    return Math.hypot(this.x, this.y, this.z);
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  normalize() {
    const l = this.length() || 1;
    return this.multiplyScalar(1 / l);
  }

  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  distanceToSquared(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v) {
    return this.crossVectors(this, v);
  }

  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  lerp(v, t) {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }

  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }

  /** q * v (Three と同一の式)。 */
  applyQuaternion(q) {
    const vx = this.x, vy = this.y, vz = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    // v + w*t + cross(q.xyz, t)
    this.x = vx + qw * tx + qy * tz - qz * ty;
    this.y = vy + qw * ty + qz * tx - qx * tz;
    this.z = vz + qw * tz + qx * ty - qy * tx;
    return this;
  }

  /** 列優先 4x4 のアフィン変換 (w=1 とみなす。ai は射影行列をこれに掛けない)。 */
  applyMatrix4(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    this.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    this.z = e[2] * x + e[6] * y + e[10] * z + e[14];
    return this;
  }

  applyMatrix3(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[3] * y + e[6] * z;
    this.y = e[1] * x + e[4] * y + e[7] * z;
    this.z = e[2] * x + e[5] * y + e[8] * z;
    return this;
  }

  setFromMatrixPosition(m) {
    const e = m.elements;
    this.x = e[12];
    this.y = e[13];
    this.z = e[14];
    return this;
  }

  toArray(arr = [], offset = 0) {
    arr[offset] = this.x;
    arr[offset + 1] = this.y;
    arr[offset + 2] = this.z;
    return arr;
  }
}

/** データホルダ。Quaternion.setFromEuler が読む。既定 order は Three と同じ 'XYZ'。 */
export class Euler {
  constructor(x = 0, y = 0, z = 0, order = 'XYZ') {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
  }

  set(x, y, z, order = this.order) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
    return this;
  }
}

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  set(x, y, z, w) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  copy(q) {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  clone() {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }

  identity() {
    return this.set(0, 0, 0, 1);
  }

  /** 単位四元数前提の逆元 = 共役 (Three の invert と同じ実装)。 */
  invert() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  normalize() {
    let l = Math.hypot(this.x, this.y, this.z, this.w);
    if (l === 0) return this.identity();
    l = 1 / l;
    this.x *= l;
    this.y *= l;
    this.z *= l;
    this.w *= l;
    return this;
  }

  /** this = this * q (Three と同じ側)。 */
  multiply(q) {
    return this.multiplyQuaternions(this, q);
  }

  /** this = q * this (Three と同じ側)。 */
  premultiply(q) {
    return this.multiplyQuaternions(q, this);
  }

  multiplyQuaternions(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w;
    const bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  setFromAxisAngle(axis, angle) {
    const half = angle / 2;
    const s = Math.sin(half);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(half);
    return this;
  }

  /** Three と同一のアルゴリズム。m は純回転 (スケールなし) であること。 */
  setFromRotationMatrix(m) {
    const e = m.elements;
    const m11 = e[0], m12 = e[4], m13 = e[8];
    const m21 = e[1], m22 = e[5], m23 = e[9];
    const m31 = e[2], m32 = e[6], m33 = e[10];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s;
      this.x = (m32 - m23) * s;
      this.y = (m13 - m31) * s;
      this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s;
      this.x = 0.25 * s;
      this.y = (m12 + m21) / s;
      this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s;
      this.x = (m12 + m21) / s;
      this.y = 0.25 * s;
      this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s;
      this.x = (m13 + m31) / s;
      this.y = (m23 + m32) / s;
      this.z = 0.25 * s;
    }
    return this;
  }

  /** 単位ベクトル from → to の最短回転 (Three と同一、反平行の分岐込み)。 */
  setFromUnitVectors(vFrom, vTo) {
    let r = vFrom.dot(vTo) + 1;
    if (r < 1e-8) {
      // 反平行: 任意の直交軸まわりに 180 度
      r = 0;
      if (Math.abs(vFrom.x) > Math.abs(vFrom.z)) {
        this.set(-vFrom.y, vFrom.x, 0, r);
      } else {
        this.set(0, -vFrom.z, vFrom.y, r);
      }
    } else {
      this.x = vFrom.y * vTo.z - vFrom.z * vTo.y;
      this.y = vFrom.z * vTo.x - vFrom.x * vTo.z;
      this.z = vFrom.x * vTo.y - vFrom.y * vTo.x;
      this.w = r;
    }
    return this.normalize();
  }

  /**
   * this = slerp(a, b, t)。deathfall.js の姿勢ブレンドが使う。
   * 符号合わせ (最短経路) 込みの標準実装。
   */
  slerpQuaternions(a, b, t) {
    let ax = a.x, ay = a.y, az = a.z, aw = a.w;
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    let cos = ax * bx + ay * by + az * bz + aw * bw;
    if (cos < 0) {
      cos = -cos;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    let s0, s1;
    if (cos > 0.9995) {
      // ほぼ同一: 線形で十分 (数値誤差で NaN を出さない)
      s0 = 1 - t;
      s1 = t;
    } else {
      const omega = Math.acos(cos);
      const so = Math.sin(omega);
      s0 = Math.sin((1 - t) * omega) / so;
      s1 = Math.sin(t * omega) / so;
    }
    this.x = ax * s0 + bx * s1;
    this.y = ay * s0 + by * s1;
    this.z = az * s0 + bz * s1;
    this.w = aw * s0 + bw * s1;
    return this.normalize();
  }

  /** Three と同一の式 (6 order 対応。ai は 'XYZ' と 'YXZ' を使う)。 */
  setFromEuler(euler) {
    const c1 = Math.cos(euler.x / 2), c2 = Math.cos(euler.y / 2), c3 = Math.cos(euler.z / 2);
    const s1 = Math.sin(euler.x / 2), s2 = Math.sin(euler.y / 2), s3 = Math.sin(euler.z / 2);
    switch (euler.order) {
      case 'XYZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'YXZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'ZXY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'ZYX':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'YZX':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'XZY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      default:
        throw new Error(`[ai math3] unknown euler order "${euler.order}"`);
    }
    return this;
  }
}

export class Matrix3 {
  constructor() {
    // 列優先 (Three と同じ)
    this.elements = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  /** 4x4 の上 3x3 の逆転置 (Three の getNormalMatrix と同一)。 */
  getNormalMatrix(m4) {
    const me = m4.elements;
    const a = me[0], b = me[1], c = me[2];
    const d = me[4], e = me[5], f = me[6];
    const g = me[8], h = me[9], i = me[10];
    const A = e * i - f * h;
    const B = f * g - d * i;
    const C = d * h - e * g;
    let det = a * A + b * B + c * C;
    if (det === 0) det = 1e-12;
    const s = 1 / det;
    const t = this.elements;
    // inverse を転置して格納 = (M^-1)^T
    t[0] = A * s;
    t[1] = (c * h - b * i) * s;
    t[2] = (b * f - c * e) * s;
    t[3] = B * s;
    t[4] = (a * i - c * g) * s;
    t[5] = (c * d - a * f) * s;
    t[6] = C * s;
    t[7] = (b * g - a * h) * s;
    t[8] = (a * e - b * d) * s;
    // 上は「余因子行列 * s」= inverse-transpose そのもの
    return this;
  }
}

export class Matrix4 {
  constructor() {
    /** 列優先。translation は [12],[13],[14] — Babylon Matrix の .m と同レイアウト。 */
    this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  identity() {
    const e = this.elements;
    e[0] = 1; e[4] = 0; e[8] = 0; e[12] = 0;
    e[1] = 0; e[5] = 1; e[9] = 0; e[13] = 0;
    e[2] = 0; e[6] = 0; e[10] = 1; e[14] = 0;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return this;
  }

  copy(m) {
    const a = this.elements, b = m.elements;
    for (let i = 0; i < 16; i++) a[i] = b[i];
    return this;
  }

  clone() {
    return new Matrix4().copy(this);
  }

  makeBasis(x, y, z) {
    const e = this.elements;
    e[0] = x.x; e[4] = y.x; e[8] = z.x; e[12] = 0;
    e[1] = x.y; e[5] = y.y; e[9] = z.y; e[13] = 0;
    e[2] = x.z; e[6] = y.z; e[10] = z.z; e[14] = 0;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return this;
  }

  /** Three と同じ 2 形態: setPosition(v) / setPosition(x, y, z)。 */
  setPosition(x, y, z) {
    const e = this.elements;
    if (typeof x === 'object') {
      e[12] = x.x;
      e[13] = x.y;
      e[14] = x.z;
    } else {
      e[12] = x;
      e[13] = y;
      e[14] = z;
    }
    return this;
  }

  compose(position, quaternion, scale) {
    const e = this.elements;
    const x = quaternion.x, y = quaternion.y, z = quaternion.z, w = quaternion.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = scale.x, sy = scale.y, sz = scale.z;
    e[0] = (1 - (yy + zz)) * sx;
    e[1] = (xy + wz) * sx;
    e[2] = (xz - wy) * sx;
    e[3] = 0;
    e[4] = (xy - wz) * sy;
    e[5] = (1 - (xx + zz)) * sy;
    e[6] = (yz + wx) * sy;
    e[7] = 0;
    e[8] = (xz + wy) * sz;
    e[9] = (yz - wx) * sz;
    e[10] = (1 - (xx + yy)) * sz;
    e[11] = 0;
    e[12] = position.x;
    e[13] = position.y;
    e[14] = position.z;
    e[15] = 1;
    return this;
  }

  /** this = a * b (列ベクトル規約。Three と同じ)。 */
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements;
    const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
    const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
    const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
    const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];
    const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
    const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
    const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
    const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];
    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
    return this;
  }
}

/**
 * シーングラフの最小実装 — Three の Object3D/Bone のうち、rig と animator が
 * 使う部分だけ。**描画には一切関与しない**: これは純粋な CPU 側の姿勢計算木で、
 * 最終的なボーン行列は agent.js が毎フレーム Babylon の Skeleton に書き写す。
 *
 * Three との差分 (意図的な簡略化):
 * - matrixAutoUpdate は常に false 扱い。position/quaternion を書いたら
 *   updateMatrix() を呼ぶこと (animator は元からそうしている)。
 * - updateMatrixWorld() は無条件に部分木を再計算する (dirty フラグなし)。
 *   25 ボーン × compose は毎フレームでも安価で、フラグのバグより安い。
 */
export class Object3D {
  constructor() {
    this.name = '';
    this.position = new Vector3();
    this.quaternion = new Quaternion();
    this.scale = new Vector3(1, 1, 1);
    this.matrix = new Matrix4();
    this.matrixWorld = new Matrix4();
    this.parent = null;
    this.children = [];
    /** Three API 互換のため存在するが、この shim では常に手動更新。 */
    this.matrixAutoUpdate = false;
  }

  add(child) {
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    child.parent = this;
    this.children.push(child);
    return this;
  }

  remove(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parent = null;
    }
    return this;
  }

  updateMatrix() {
    this.matrix.compose(this.position, this.quaternion, this.scale);
    return this;
  }

  updateMatrixWorld() {
    if (this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    else this.matrixWorld.copy(this.matrix);
    for (let i = 0; i < this.children.length; i++) this.children[i].updateMatrixWorld();
    return this;
  }

  /**
   * matrixWorld から回転だけ取り出す。基底列を正規化してから変換するので、
   * 祖先に均一スケール (agent.scale) がいても正しい。
   */
  getWorldQuaternion(out) {
    const e = this.matrixWorld.elements;
    const sx = Math.hypot(e[0], e[1], e[2]) || 1;
    const sy = Math.hypot(e[4], e[5], e[6]) || 1;
    const sz = Math.hypot(e[8], e[9], e[10]) || 1;
    _rot.elements[0] = e[0] / sx; _rot.elements[1] = e[1] / sx; _rot.elements[2] = e[2] / sx;
    _rot.elements[4] = e[4] / sy; _rot.elements[5] = e[5] / sy; _rot.elements[6] = e[6] / sy;
    _rot.elements[8] = e[8] / sz; _rot.elements[9] = e[9] / sz; _rot.elements[10] = e[10] / sz;
    return out.setFromRotationMatrix(_rot);
  }
}

const _rot = new Matrix4();

/** Three.Bone 相当。Object3D と同じだが名前で区別できるようにしておく。 */
export class Bone extends Object3D {
  constructor() {
    super();
    this.isBone = true;
  }
}
