import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';

/**
 * Procedural hard-surface geometry kit for the weapons — Babylon 移植版。
 *
 * ## 移植方針 (ここが最重要)
 *
 * Three 版の parts.js (2,072 行) と models/*.js (1,114 行) は、このファイルが
 * export するヘルパ API **だけ** に依存して書かれている。実銃の寸法が mm 単位で
 * 作り込まれた資産なので、**あちら側は 1 行も書き換えない**。代わりにこのファイルが
 * Three の BufferGeometry と同じ「見た目の API」を持つ軽量ジオメトリ (`Geo`) を
 * 純 JS で提供する。Babylon への変換は最後の `meshFromGeo()` 1 箇所だけで行う。
 *
 * 従って `Geo` は Three の BufferGeometry が parts/models から呼ばれる形
 * (clone / dispose / translate / rotateX/Y/Z / scale) を厳密に再現する。
 * 回転の符号・合成順序 (Assembly の Euler 'XYZ') を変えると、parts.js の
 * コメントに書かれた「rz を先に適用する」前提が壊れて M-LOK やセレクタが
 * あらぬ向きに付くので、Three の定義をそのまま写している。
 *
 * ## 座標系
 *
 * scene.useRightHandedSystem = true (core/engine.js 参照)。武器ローカルは
 * Three 版と同じ +X 右 / +Y 上 / -Z 銃口。左手系に直さないこと。
 *
 * ## UV
 *
 * Three 版は triplanar 手続きシェーダで UV 不要だったが、Babylon の PBRMaterial は
 * UV でテクスチャをサンプルする。各プリミティブは「実寸 (m) × UVK」の平面/円筒
 * マッピングを生成する。UVK は武器スケールのテクセル密度 (0.10-0.15 m でタイルが
 * 一周する — Three 版 materials.js の知見) を、**共有テクスチャの uScale を触らずに**
 * 実現するための唯一のノブ。ライブラリのテクスチャは world と共有なので、
 * uScale をいじると街の壁のタイルまで変わってしまう。
 */

/** 1 m あたりの UV タイル数。ライブラリの world ≈ 0.9 m と合わせ ~0.15 m/タイル。 */
const UVK = 6;

const TAU2 = Math.PI * 2;

/* ========================================================================== */
/*  Geo — Three.BufferGeometry 互換の最小ジオメトリ                           */
/* ========================================================================== */

export class Geo {
  /**
   * @param {number[]|Float32Array} positions xyz...
   * @param {number[]|Float32Array} normals  xyz...
   * @param {number[]|Float32Array} uvs      uv...
   * @param {number[]|Uint32Array}  indices
   */
  constructor(positions, normals, uvs, indices) {
    this.positions = positions instanceof Float32Array ? positions : new Float32Array(positions);
    this.normals = normals instanceof Float32Array ? normals : new Float32Array(normals);
    this.uvs = uvs instanceof Float32Array ? uvs : new Float32Array(uvs);
    this.indices = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
  }

  clone() {
    return new Geo(
      this.positions.slice(),
      this.normals.slice(),
      this.uvs.slice(),
      this.indices.slice()
    );
  }

  /** Three API 互換のための no-op。GC に任せる。 */
  dispose() {}

  translate(x, y, z) {
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      p[i] += x;
      p[i + 1] += y;
      p[i + 2] += z;
    }
    return this;
  }

  /** 回転は Three と同じ右手系・能動回転。法線も同じ回転を受ける。 */
  _rot(m00, m01, m02, m10, m11, m12, m20, m21, m22) {
    const p = this.positions;
    const n = this.normals;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      p[i] = m00 * x + m01 * y + m02 * z;
      p[i + 1] = m10 * x + m11 * y + m12 * z;
      p[i + 2] = m20 * x + m21 * y + m22 * z;
      const nx = n[i];
      const ny = n[i + 1];
      const nz = n[i + 2];
      n[i] = m00 * nx + m01 * ny + m02 * nz;
      n[i + 1] = m10 * nx + m11 * ny + m12 * nz;
      n[i + 2] = m20 * nx + m21 * ny + m22 * nz;
    }
    return this;
  }

  rotateX(a) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return this._rot(1, 0, 0, 0, c, -s, 0, s, c);
  }

  rotateY(a) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return this._rot(c, 0, s, 0, 1, 0, -s, 0, c);
  }

  rotateZ(a) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return this._rot(c, -s, 0, s, c, 0, 0, 0, 1);
  }

  scale(x, y, z) {
    const p = this.positions;
    const n = this.normals;
    // 法線は逆転置 = 1/s 倍してから正規化 (非一様スケールで向きが保たれる)。
    const ix = 1 / (x || 1e-9);
    const iy = 1 / (y || 1e-9);
    const iz = 1 / (z || 1e-9);
    for (let i = 0; i < p.length; i += 3) {
      p[i] *= x;
      p[i + 1] *= y;
      p[i + 2] *= z;
      let nx = n[i] * ix;
      let ny = n[i + 1] * iy;
      let nz = n[i + 2] * iz;
      const l = Math.hypot(nx, ny, nz) || 1;
      n[i] = nx / l;
      n[i + 1] = ny / l;
      n[i + 2] = nz / l;
    }
    if (x * y * z < 0) flipWinding(this);
    return this;
  }
}

/** 面の表裏を反転する (鏡像化した後の巻き順の直し)。 */
function flipWinding(geo) {
  const idx = geo.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i];
    idx[i] = idx[i + 2];
    idx[i + 2] = t;
  }
  return geo;
}

/** 面法線の加算平均で頂点法線を求める (ラップ済みインデックスなら継ぎ目も滑らか)。 */
function computeNormals(geo) {
  const p = geo.positions;
  const idx = geo.indices;
  const n = new Float32Array(p.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const abx = p[b] - p[a];
    const aby = p[b + 1] - p[a + 1];
    const abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a];
    const acy = p[c + 1] - p[a + 1];
    const acz = p[c + 2] - p[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  geo.normals = n;
  return geo;
}

/* ========================================================================== */
/*  primitives                                                                */
/* ========================================================================== */

/**
 * Chamfered box。Three の RoundedBoxGeometry と同じ「subdivided cube を内側
 * ボックスへクランプ + 角丸半径ぶん押し出す」方式。法線は押し出し方向そのもの
 * なので解析的に正しい。seg=1 で 45° チャンファ、2-3 でフィレット。
 */
export function box(w, h, d, chamfer = 0.0012, seg = 1) {
  const r = Math.min(chamfer, Math.min(w, Math.min(h, d)) * 0.49);
  const cells = Math.max(1, seg * 2 + 1);
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;
  const inX = Math.max(1e-6, hw - r);
  const inY = Math.max(1e-6, hh - r);
  const inZ = Math.max(1e-6, hd - r);

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  // face: (原点コーナー, u 方向, v 方向)。全面 CCW (外向き) で貼る。
  const faces = [
    // +X
    { o: [hw, -hh, hd], u: [0, 0, -d], v: [0, h, 0] },
    // -X
    { o: [-hw, -hh, -hd], u: [0, 0, d], v: [0, h, 0] },
    // +Y
    { o: [-hw, hh, hd], u: [w, 0, 0], v: [0, 0, -d] },
    // -Y
    { o: [-hw, -hh, -hd], u: [w, 0, 0], v: [0, 0, d] },
    // +Z
    { o: [-hw, -hh, hd], u: [w, 0, 0], v: [0, h, 0] },
    // -Z
    { o: [hw, -hh, -hd], u: [-w, 0, 0], v: [0, h, 0] },
  ];

  for (const f of faces) {
    const base = positions.length / 3;
    for (let j = 0; j <= cells; j++) {
      for (let i = 0; i <= cells; i++) {
        const s = i / cells;
        const t = j / cells;
        let x = f.o[0] + f.u[0] * s + f.v[0] * t;
        let y = f.o[1] + f.u[1] * s + f.v[1] * t;
        let z = f.o[2] + f.u[2] * s + f.v[2] * t;
        if (r > 1e-6) {
          // 内側ボックスへクランプし、はみ出しベクトル方向へ r 押し出す。
          const cx = Math.max(-inX, Math.min(inX, x));
          const cy = Math.max(-inY, Math.min(inY, y));
          const cz = Math.max(-inZ, Math.min(inZ, z));
          let dx = x - cx;
          let dy = y - cy;
          let dz = z - cz;
          const l = Math.hypot(dx, dy, dz) || 1;
          dx /= l;
          dy /= l;
          dz /= l;
          x = cx + dx * r;
          y = cy + dy * r;
          z = cz + dz * r;
          normals.push(dx, dy, dz);
        } else {
          // 押し出しゼロ = 平面。面法線は u×v。
          const nx = f.u[1] * f.v[2] - f.u[2] * f.v[1];
          const ny = f.u[2] * f.v[0] - f.u[0] * f.v[2];
          const nz = f.u[0] * f.v[1] - f.u[1] * f.v[0];
          const l = Math.hypot(nx, ny, nz) || 1;
          normals.push(nx / l, ny / l, nz / l);
        }
        positions.push(x, y, z);
        uvs.push(s * Math.hypot(f.u[0], f.u[1], f.u[2]) * UVK, t * Math.hypot(f.v[0], f.v[1], f.v[2]) * UVK);
      }
    }
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const a = base + j * (cells + 1) + i;
        const b = a + 1;
        const c = a + cells + 2;
        const dI = a + cells + 1;
        indices.push(a, b, c, a, c, dI);
      }
    }
  }
  return new Geo(positions, normals, uvs, indices);
}

/** A softly rounded block — grips, palm swells, butt pads. */
export function blob(w, h, d, radius = 0.006, seg = 3) {
  return box(w, h, d, radius, seg);
}

/**
 * Z 軸まわりの回転体。`profile` は [axialZ, radius] のフラット配列。
 *
 * 頂点配置は Three 版 (LatheGeometry を +90° X 回転) と同一:
 *   vertex(i, φ) = (r_i sinφ, -r_i cosφ, z_i)
 * 巻き順は「z が増える向きに作った輪郭で法線が外向き」になるように張ってある。
 * 全周のときは継ぎ目の重複列を作らずインデックスをラップする — 法線の加算平均が
 * 継ぎ目でも自動的に滑らかになるため。
 */
export function latheZ(profile, seg = 24, phiStart = 0, phiLength = TAU2) {
  const n = profile.length;
  const closed = Math.abs(phiLength - TAU2) < 1e-6;
  const cols = closed ? seg : seg + 1;

  const positions = new Float32Array(n * cols * 3);
  const uvs = new Float32Array(n * cols * 2);
  const indices = [];

  // 輪郭の弧長 (v 座標)。
  const arc = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const dz = profile[i][0] - profile[i - 1][0];
    const dr = profile[i][1] - profile[i - 1][1];
    arc[i] = arc[i - 1] + Math.hypot(dz, dr);
  }

  let k = 0;
  let ku = 0;
  for (let i = 0; i < n; i++) {
    const z = profile[i][0];
    const r = Math.max(1e-5, profile[i][1]);
    for (let j = 0; j < cols; j++) {
      const phi = phiStart + (j / seg) * phiLength;
      positions[k++] = r * Math.sin(phi);
      positions[k++] = -r * Math.cos(phi);
      positions[k++] = z;
      uvs[ku++] = phi * r * UVK;
      uvs[ku++] = arc[i] * UVK;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const j1 = closed ? (j + 1) % seg : j + 1;
      const a = i * cols + j;
      const b = i * cols + j1;
      const c = (i + 1) * cols + j1;
      const d = (i + 1) * cols + j;
      indices.push(a, b, c, a, c, d);
    }
  }
  const geo = new Geo(positions, new Float32Array(positions.length), uvs, indices);
  return computeNormals(geo);
}

/**
 * Tube along Z with a real wall: outer surface, inner bore, and crowned ends.
 */
export function tubeZ(rOuter, rInner, len, seg = 24, crown = 0.0006) {
  const z0 = -len / 2;
  const z1 = len / 2;
  const c = Math.min(crown, (rOuter - rInner) * 0.4);
  return latheZ(
    [
      [z0 + c, rInner],
      [z0, rInner + c],
      [z0, rOuter - c],
      [z0 + c, rOuter],
      [z1 - c, rOuter],
      [z1, rOuter - c],
      [z1, rInner + c],
      [z1 - c, rInner],
    ],
    seg
  );
}

/** Solid cylinder along Z with chamfered rims. */
export function rodZ(r0, r1, len, seg = 20, chamfer = 0.0008) {
  const z0 = -len / 2;
  const z1 = len / 2;
  const c = Math.min(chamfer, len * 0.4, Math.min(r0, r1) * 0.5);
  return latheZ(
    [
      [z0, 0],
      [z0, r0 - c],
      [z0 + c, r0],
      [z1 - c, r1],
      [z1, r1 - c],
      [z1, 0],
    ],
    seg
  );
}

/**
 * Sphere-ish detail blob。頂点の極軸は +Z (Three 版の SphereGeometry を
 * rotateX(π/2) した後の姿をそのまま生成)。法線 = 位置/半径で解析的。
 */
export function dome(r, seg = 16, cut = 0.6) {
  const hSeg = Math.max(4, Math.round(seg * 0.5));
  const thetaLen = Math.PI * cut;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const cols = seg;
  for (let i = 0; i <= hSeg; i++) {
    const th = (i / hSeg) * thetaLen;
    const rz = Math.cos(th) * r;
    const rr = Math.sin(th) * r;
    for (let j = 0; j < cols; j++) {
      const phi = (j / seg) * TAU2;
      const x = rr * Math.sin(phi);
      const y = -rr * Math.cos(phi);
      positions.push(x, y, rz);
      const l = Math.hypot(x, y, rz) || 1;
      normals.push(x / l, y / l, rz / l);
      uvs.push(phi * rr * UVK, th * r * UVK);
    }
  }
  for (let i = 0; i < hSeg; i++) {
    for (let j = 0; j < cols; j++) {
      const j1 = (j + 1) % cols;
      const a = i * cols + j;
      const b = i * cols + j1;
      const c = (i + 1) * cols + j1;
      const d = (i + 1) * cols + j;
      // 極軸 +Z、θ が増えると z が減る → 外向きは (a,b,c),(a,c,d)。
      indices.push(a, b, c, a, c, d);
    }
  }
  return new Geo(positions, normals, uvs, indices);
}

/* -------------------------------------------------------------------------- */
/*  polygon utilities (extrude 用)                                            */
/* -------------------------------------------------------------------------- */

function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** 反時計回り (正の面積) に揃える。 */
function ensureCCW(pts) {
  return signedArea(pts) < 0 ? pts.slice().reverse() : pts.slice();
}

/**
 * マイターオフセット。CCW 多角形を外向きに d だけ太らせる (d<0 で痩せる)。
 * 尖った頂点はマイター長を 3d にクランプ (bevel 幅は mm オーダーなので十分)。
 */
function offsetPolygon(pts, d) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    // CCW 多角形の外向き法線は (dy, -dx)。
    let e0x = p1[0] - p0[0];
    let e0y = p1[1] - p0[1];
    let e1x = p2[0] - p1[0];
    let e1y = p2[1] - p1[1];
    let l0 = Math.hypot(e0x, e0y) || 1;
    let l1 = Math.hypot(e1x, e1y) || 1;
    const n0x = e0y / l0;
    const n0y = -e0x / l0;
    const n1x = e1y / l1;
    const n1y = -e1x / l1;
    let mx = n0x + n1x;
    let my = n0y + n1y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      // 180° 折り返し: エッジ法線をそのまま使う
      mx = n0x;
      my = n0y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const denom = Math.max(0.34, mx * n0x + my * n0y); // miter clamp ~3d
    out.push([p1[0] + (mx * d) / denom, p1[1] + (my * d) / denom]);
  }
  return out;
}

/** 単純多角形 (穴なし・CCW) の ear clipping。indices はローカル添字。 */
function earClip(pts) {
  const n = pts.length;
  const idx = [];
  const V = [];
  for (let i = 0; i < n; i++) V.push(i);
  const cross = (o, a, b) =>
    (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1]) -
    (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
  const inTri = (p, a, b, c) => {
    const s1 = (pts[b][0] - pts[a][0]) * (pts[p][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[p][0] - pts[a][0]);
    const s2 = (pts[c][0] - pts[b][0]) * (pts[p][1] - pts[b][1]) - (pts[c][1] - pts[b][1]) * (pts[p][0] - pts[b][0]);
    const s3 = (pts[a][0] - pts[c][0]) * (pts[p][1] - pts[c][1]) - (pts[a][1] - pts[c][1]) * (pts[p][0] - pts[c][0]);
    return s1 > 0 && s2 > 0 && s3 > 0;
  };
  let guard = 0;
  while (V.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < V.length; i++) {
      const a = V[(i - 1 + V.length) % V.length];
      const b = V[i];
      const c = V[(i + 1) % V.length];
      if (cross(a, b, c) <= 1e-12) continue; // 凹頂点
      let ear = true;
      for (const p of V) {
        if (p === a || p === b || p === c) continue;
        if (inTri(p, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (ear) {
        idx.push(a, b, c);
        V.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) {
      // 数値退化時のフォールバック: 凸頂点を無条件に切る (穴なし前提なので安全側)
      let cut = false;
      for (let i = 0; i < V.length; i++) {
        const a = V[(i - 1 + V.length) % V.length];
        const b = V[i];
        const c = V[(i + 1) % V.length];
        if (cross(a, b, c) > 0) {
          idx.push(a, b, c);
          V.splice(i, 1);
          cut = true;
          break;
        }
      }
      if (!cut) break;
    }
  }
  if (V.length === 3) idx.push(V[0], V[1], V[2]);
  return idx;
}

/**
 * 穴つきキャップ。**この武器キットの穴は必ず外形と同じ頂点数・同じ回り順で
 * 作られている** (roundRect 同士、トリガーガードの外/内 7 点、など) ので、
 * 外形 i ↔ 穴 i を四角形ストリップで結ぶだけで正しく張れる。汎用の穴あき
 * 三角形分割 (earcut) を持ち込まないのは、この不変条件が既に models/parts の
 * 設計に織り込まれているため。**頂点数が違う穴を渡すとここで throw する** —
 * 黙って壊れた面を張るより早期に気づけるほうがよい。
 */
function capWithHole(outer, hole) {
  if (outer.length !== hole.length) {
    throw new Error(`[weapons/geometry] extrude hole vertex count ${hole.length} != outline ${outer.length}`);
  }
  const n = outer.length;
  // 開始インデックスを最近傍で合わせる (どちらも同じ回り順である前提)。
  let bestK = 0;
  let bestD = Infinity;
  for (let k = 0; k < n; k++) {
    const dx = hole[k][0] - outer[0][0];
    const dy = hole[k][1] - outer[0][1];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      bestK = k;
    }
  }
  const idx = [];
  for (let i = 0; i < n; i++) {
    const o0 = i;
    const o1 = (i + 1) % n;
    const h0 = n + ((bestK + i) % n);
    const h1 = n + ((bestK + i + 1) % n);
    idx.push(o0, o1, h0, h0, o1, h1);
  }
  return idx;
}

/**
 * Extrude a 2-D outline (in XY) along Z with a real bevel on both faces.
 * `pts` is a flat array of [x, y]; it is closed automatically.
 *
 * Three の ExtrudeGeometry と同じく、キャップ面 (±Z) は描いた輪郭そのもので、
 * 中央部の側壁は bevel ぶん外へ太る (穴は内へ痩せる)。総奥行きは `depth`。
 */
export function extrude(pts, depth, opts = {}) {
  const bevelIn = opts.bevel ?? 0.0008;
  const D = Math.max(2e-4, depth);
  const b = Math.min(bevelIn, D * 0.49);
  const bevelSegs = Math.max(1, opts.bevelSegments ?? 1);

  const outer = ensureCCW(pts);
  const holes = (opts.holes ?? []).map((h) => ensureCCW(h));

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const pushCap = (contour2, holes2, z, front) => {
    const base = positions.length / 3;
    const all = [...contour2, ...(holes2[0] ?? [])];
    for (const [x, y] of all) {
      positions.push(x, y, z);
      normals.push(0, 0, front ? 1 : -1);
      uvs.push(x * UVK, y * UVK);
    }
    let tri;
    if (holes2.length > 0) tri = capWithHole(contour2, holes2[0]);
    else tri = earClip(contour2);
    for (let i = 0; i < tri.length; i += 3) {
      // CCW 輪郭 + z 前面で CCW = 表。背面は反転。
      if (front) indices.push(base + tri[i], base + tri[i + 1], base + tri[i + 2]);
      else indices.push(base + tri[i], base + tri[i + 2], base + tri[i + 1]);
    }
  };

  // 側壁 + ベベル: 輪郭ごとにリング列を作って張る。
  // sign: 外形は外向き (+)、穴は材料側 = 穴の内向き (−)。
  const pushWall = (contour2, sign) => {
    const n = contour2.length;
    // リング列: [z, offset] — 前キャップ縁 → 前ベベル → 後ベベル → 後キャップ縁
    const ringsSpec = [];
    for (let k = 0; k <= bevelSegs; k++) {
      const t = k / bevelSegs;
      // 1/4 円のベベル断面。
      ringsSpec.push([-D / 2 + b * (1 - Math.cos((t * Math.PI) / 2)), b * Math.sin((t * Math.PI) / 2)]);
    }
    for (let k = bevelSegs; k >= 0; k--) {
      const t = k / bevelSegs;
      ringsSpec.push([D / 2 - b * (1 - Math.cos((t * Math.PI) / 2)), b * Math.sin((t * Math.PI) / 2)]);
    }
    const base = positions.length / 3;
    // 輪郭の弧長 (u 座標)。
    const arc = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const a = contour2[i];
      const c = contour2[(i + 1) % n];
      arc[i + 1] = arc[i] + Math.hypot(c[0] - a[0], c[1] - a[1]);
    }
    const ringPts = ringsSpec.map(([z, off]) => ({
      z,
      pts: Math.abs(off) < 1e-9 ? contour2 : offsetPolygon(contour2, off * sign),
    }));
    for (const ring of ringPts) {
      for (let i = 0; i < n; i++) {
        positions.push(ring.pts[i][0], ring.pts[i][1], ring.z);
        normals.push(0, 0, 0); // 後で computeNormals
        uvs.push(arc[i] * UVK, ring.z * UVK);
      }
    }
    const rows = ringPts.length;
    for (let r = 0; r < rows - 1; r++) {
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n;
        const a = base + r * n + i;
        const bb = base + r * n + i1;
        const c = base + (r + 1) * n + i1;
        const d = base + (r + 1) * n + i;
        // CCW 輪郭・z が増える向き → 外向きは (a,bb,c),(a,c,d) を反転した側…
        // 検算: 前面 z=-D/2 側から z+ へ。エッジ方向 e=(contour i→i1)、行方向 +z。
        // 外向き法線 = e × z? CCW で外向きは (ey,-ex)。cross((ex,ey,0),(0,0,1)) = (ey,-ex,0) ✓
        // 三角形 (a,bb,c): (bb-a)=e, (c-a)=e+z → n = e×(e+z) = e×z = (ey,-ex,0) 外向き ✓
        if (sign > 0) indices.push(a, bb, c, a, c, d);
        else indices.push(a, c, bb, a, d, c);
      }
    }
  };

  // キャップ: +Z 面が front (CCW = 表)、-Z 面は巻き順を反転。
  pushCap(outer, holes, D / 2, true);
  pushCap(outer, holes, -D / 2, false);

  const wallStart = positions.length / 3;
  pushWall(outer, +1);
  for (const h of holes) pushWall(h, -1);

  const geo = new Geo(positions, normals, uvs, indices);
  // 側壁の法線だけ加算平均で求める (キャップは解析値を保持)。
  const tmp = new Geo(geo.positions, new Float32Array(geo.positions.length), geo.uvs, geo.indices);
  computeNormals(tmp);
  for (let i = wallStart * 3; i < geo.normals.length; i++) geo.normals[i] = tmp.normals[i];
  return geo;
}

/** A rounded rectangle outline, for extruded plates that need soft corners. */
export function roundRect(w, h, r, seg = 3) {
  const pts = [];
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const corners = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, -Math.PI / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** Torus in the XY plane (sling loops, trigger guard bows, QD rings). */
export function ring(radius, thickness, seg = 20, rings = 8, arc = TAU2) {
  const closedU = Math.abs(arc - TAU2) < 1e-6;
  const uCols = closedU ? seg : seg + 1;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= rings; j++) {
    const v = (j / rings) * TAU2;
    const cv = Math.cos(v);
    const sv = Math.sin(v);
    for (let i = 0; i < uCols; i++) {
      const u = (i / seg) * arc;
      const cu = Math.cos(u);
      const su = Math.sin(u);
      positions.push((radius + thickness * cv) * cu, (radius + thickness * cv) * su, thickness * sv);
      normals.push(cv * cu, cv * su, sv);
      uvs.push(u * radius * UVK, v * thickness * UVK);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const i1 = closedU ? (i + 1) % uCols : i + 1;
      const a = j * uCols + i;
      const b = j * uCols + i1;
      const c = (j + 1) * uCols + i1;
      const d = (j + 1) * uCols + i;
      indices.push(a, c, b, a, d, c);
    }
  }
  return new Geo(positions, normals, uvs, indices);
}

/** 平板円盤 (XY 平面、法線 +Z)。レティクルのコア/ハロー用。 */
export function disk(r, seg = 32, thetaStart = 0, thetaLength = TAU2) {
  const positions = [0, 0, 0];
  const normals = [0, 0, 1];
  const uvs = [0.5, 0.5];
  const indices = [];
  const closed = Math.abs(thetaLength - TAU2) < 1e-6;
  const cols = closed ? seg : seg + 1;
  for (let i = 0; i < cols; i++) {
    const a = thetaStart + (i / seg) * thetaLength;
    positions.push(Math.cos(a) * r, Math.sin(a) * r, 0);
    normals.push(0, 0, 1);
    uvs.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
  }
  for (let i = 0; i < seg; i++) {
    const i1 = closed ? ((i + 1) % seg) + 1 : i + 2;
    indices.push(0, i + 1, i1);
  }
  return new Geo(positions, normals, uvs, indices);
}

/** 平板リング (XY 平面、法線 +Z)。Three の RingGeometry 相当。 */
export function diskRing(rInner, rOuter, seg = 32, thetaStart = 0, thetaLength = TAU2) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const closed = Math.abs(thetaLength - TAU2) < 1e-6;
  const cols = closed ? seg : seg + 1;
  for (let i = 0; i < cols; i++) {
    const a = thetaStart + (i / seg) * thetaLength;
    const c = Math.cos(a);
    const s = Math.sin(a);
    positions.push(c * rInner, s * rInner, 0, c * rOuter, s * rOuter, 0);
    normals.push(0, 0, 1, 0, 0, 1);
    uvs.push(0.25, i / seg, 1, i / seg);
  }
  for (let i = 0; i < seg; i++) {
    const i1 = closed ? (i + 1) % seg : i + 1;
    const a = i * 2;
    const b = i * 2 + 1;
    const c = i1 * 2 + 1;
    const d = i1 * 2;
    indices.push(a, b, c, a, c, d);
  }
  return new Geo(positions, normals, uvs, indices);
}

/** 正八面体 (knurl の粒)。フラットシェーディング用に面ごとに頂点を持つ。 */
function octahedron(r) {
  const v = [
    [r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r],
  ];
  const f = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let k = 0;
  for (const [a, b, c] of f) {
    const A = v[a];
    const B = v[b];
    const C = v[c];
    const nx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]);
    const ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
    const nz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const P of [A, B, C]) {
      positions.push(P[0], P[1], P[2]);
      normals.push(nx / l, ny / l, nz / l);
      uvs.push(0, 0);
      indices.push(k++);
    }
  }
  return new Geo(positions, normals, uvs, indices);
}

/**
 * Hex-socket cap screw, axis +Z, head at z=0 facing -Z.
 */
export function screw(rHead, rShank, headH, shankL, seg = 12) {
  const rSocket = rHead * 0.52;
  const g = [];
  g.push(
    latheZ(
      [
        [0, rSocket],
        [0, rHead - 0.0002],
        [0.0002, rHead],
        [headH, rHead],
        [headH, rShank],
        [headH + shankL, rShank],
        [headH + shankL, 0],
      ],
      seg
    )
  );
  const bore = latheZ(
    [
      [headH * 0.62, 0],
      [headH * 0.62, rSocket],
      [0, rSocket],
    ],
    6
  );
  g.push(bore);
  return mergeAll(g);
}

/** Knurling / checkering: a band of tiny pyramids around a cylinder. */
export function knurlBand(radius, len, count = 28, depth = 0.0004, rows = 3) {
  const parts = [];
  const cell = octahedron(depth * 2.2);
  cell.scale(1, 1, 0.55);
  for (let r = 0; r < rows; r++) {
    const z = -len / 2 + ((r + 0.5) / rows) * len;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU2 + (r % 2) * (Math.PI / count);
      const g = cell.clone();
      g.rotateZ(a);
      g.translate(Math.cos(a) * radius, Math.sin(a) * radius, z);
      parts.push(g);
    }
  }
  cell.dispose();
  return mergeAll(parts);
}

/** Fine longitudinal serrations (slide grip, handguard panels, mag ribs). */
export function serrations(w, h, len, count, depth = 0.0006, axis = 'x') {
  const parts = [];
  const step = (axis === 'x' ? w : h) / count;
  const rib = box(axis === 'x' ? step * 0.55 : w, axis === 'x' ? h : step * 0.55, len, depth * 0.9, 1);
  for (let i = 0; i < count; i++) {
    const t = -0.5 + (i + 0.5) / count;
    const g = rib.clone();
    if (axis === 'x') g.translate(t * w, 0, 0);
    else g.translate(0, t * h, 0);
    parts.push(g);
  }
  rib.dispose();
  return mergeAll(parts);
}

/**
 * MIL-STD-1913 Picatinny rail running along Z.
 * 実寸と断面の経緯は Three 版のコメント (git 履歴) を参照 — 45° の 1.5 mm
 * クラウンチャンファが「上向きの平面が specular を一枚で受ける」問題の解。
 */
export function picatinny(len, opts = {}) {
  const width = opts.width ?? 0.0212;
  const waist = opts.waist ?? 0.0157;
  const baseH = opts.baseH ?? 0.0042;
  const topH = opts.topH ?? 0.0032;
  const pitch = opts.pitch ?? 0.01055;
  const slot = opts.slot ?? 0.00535;
  const chamfer = 0.00035;
  const ch = opts.crownChamfer ?? 0.0015;

  const teeth = Math.max(1, Math.floor((len + slot) / pitch));
  const toothLen = pitch - slot;
  const parts = [];

  const base = box(width, baseH, len, chamfer, 1);
  base.translate(0, baseH / 2, 0);
  parts.push(base);

  const profile = [
    [-waist / 2, 0],
    [-width / 2, topH - ch],
    [-width / 2 + ch, topH],
    [width / 2 - ch, topH],
    [width / 2, topH - ch],
    [waist / 2, 0],
  ];
  const tooth = extrude(profile, toothLen, { bevel: 0.00025, bevelSegments: 1 });
  for (let i = 0; i < teeth; i++) {
    const z = len / 2 - toothLen / 2 - i * pitch;
    if (z - toothLen / 2 < -len / 2) break;
    const g = tooth.clone();
    g.translate(0, baseH, z);
    parts.push(g);
  }
  tooth.dispose();
  return mergeAll(parts);
}

/** M-LOK style slot: a recessed pocket with a raised lip, for handguard slats. */
export function mlokSlot(len = 0.032, wide = 0.0075, depth = 0.0022) {
  const parts = [];
  const outer = extrude(roundRect(len, wide + 0.0028, 0.0014, 3), 0.0016, { bevel: 0.0004 });
  const inner = extrude(roundRect(len - 0.0016, wide, 0.0012, 3), depth, { bevel: 0.0003 });
  inner.translate(0, 0, -depth * 0.35);
  parts.push(outer, inner);
  return mergeAll(parts);
}

/* ========================================================================== */
/*  assembly                                                                  */
/* ========================================================================== */

/** Three の Euler 'XYZ' と同じ回転行列 R = Rx·Ry·Rz (rz が最初に掛かる)。 */
function rotXYZ(rx, ry, rz) {
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  // Rx * Ry * Rz
  return [
    cy * cz, -cy * sz, sy,
    cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
    sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy,
  ];
}

/**
 * Collects transformed geometry per material, then merges each bucket into one
 * mesh. Also carries the named attachment nodes the animation rig drives.
 * API は Three 版と同一 — models/*.js が無改変で通ることが唯一の存在理由。
 */
export class Assembly {
  constructor(name) {
    this.name = name;
    this.buckets = new Map(); // matKey -> Geo[]
    this.nodes = new Map(); // name -> { pos:[x,y,z], rot:[x,y,z] }
  }

  /**
   * @param {Geo} geo    consumed (cloned internally)
   * @param {string} mat material key
   * @param {object} t   { x,y,z, rx,ry,rz, sx,sy,sz }
   */
  add(geo, mat, t = null) {
    const g = geo.clone();
    if (t) {
      const sx = t.sx ?? 1;
      const sy = t.sy ?? 1;
      const sz = t.sz ?? 1;
      const m = rotXYZ(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0);
      const tx = t.x ?? 0;
      const ty = t.y ?? 0;
      const tz = t.z ?? 0;
      const p = g.positions;
      const n = g.normals;
      const isx = 1 / (sx || 1e-9);
      const isy = 1 / (sy || 1e-9);
      const isz = 1 / (sz || 1e-9);
      for (let i = 0; i < p.length; i += 3) {
        // p' = R·(S·p) + t
        const x = p[i] * sx;
        const y = p[i + 1] * sy;
        const z = p[i + 2] * sz;
        p[i] = m[0] * x + m[1] * y + m[2] * z + tx;
        p[i + 1] = m[3] * x + m[4] * y + m[5] * z + ty;
        p[i + 2] = m[6] * x + m[7] * y + m[8] * z + tz;
        // n' = R·(n/s) を正規化 (鏡像も正しく反る)
        const nx0 = n[i] * isx;
        const ny0 = n[i + 1] * isy;
        const nz0 = n[i + 2] * isz;
        const nx = m[0] * nx0 + m[1] * ny0 + m[2] * nz0;
        const ny = m[3] * nx0 + m[4] * ny0 + m[5] * nz0;
        const nz = m[6] * nx0 + m[7] * ny0 + m[8] * nz0;
        const l = Math.hypot(nx, ny, nz) || 1;
        n[i] = nx / l;
        n[i + 1] = ny / l;
        n[i + 2] = nz / l;
      }
      if (sx * sy * sz < 0) flipWinding(g);
    }
    let list = this.buckets.get(mat);
    if (!list) this.buckets.set(mat, (list = []));
    list.push(g);
    return this;
  }

  /** Same piece on both sides of the weapon. */
  addMirrored(geo, mat, t) {
    this.add(geo, mat, t);
    this.add(geo, mat, { ...t, x: -(t.x ?? 0), sx: -(t.sx ?? 1) });
    return this;
  }

  node(name, x, y, z, rx = 0, ry = 0, rz = 0) {
    this.nodes.set(name, { pos: [x, y, z], rot: [rx, ry, rz] });
    return this;
  }

  /** @returns Map<matKey, Geo> */
  build() {
    const out = new Map();
    for (const [mat, list] of this.buckets) {
      const merged = mergeAll(list);
      if (merged) out.set(mat, merged);
    }
    this.buckets.clear();
    return out;
  }
}

/** Merge a list of geometries (単純連結。溶接は行わない — 法線は既に確定済み)。 */
export function mergeAll(list) {
  const clean = list.filter(Boolean);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];
  let vCount = 0;
  let iCount = 0;
  for (const g of clean) {
    vCount += g.positions.length / 3;
    iCount += g.indices.length;
  }
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const indices = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of clean) {
    positions.set(g.positions, vo * 3);
    normals.set(g.normals, vo * 3);
    uvs.set(g.uvs, vo * 2);
    for (let i = 0; i < g.indices.length; i++) indices[io + i] = g.indices[i] + vo;
    vo += g.positions.length / 3;
    io += g.indices.length;
  }
  return new Geo(positions, normals, uvs, indices);
}

/** Triangle count of a finished geometry, for the budget log. */
export function triCount(geo) {
  return geo.indices.length / 3;
}

/* ========================================================================== */
/*  Babylon 変換 — ここが Three との唯一の境界                                 */
/* ========================================================================== */

/**
 * Geo を Babylon Mesh にする。
 *
 * 巻き順について: このキットは GL/Three 流の「CCW = 表」でデータを作っており、
 * Babylon の既定 sideOrientation (handedness とビルダー実装に依存) と食い違う
 * 可能性がある。武器マテリアル側で backFaceCulling = false にしてあるので
 * 見た目はどちらでも壊れない (陰影は法線で決まり、法線は解析的に外向き)。
 *
 * @param {string} name
 * @param {Geo} geo
 * @param {import('@babylonjs/core/Materials/material.js').Material} material
 * @param {import('@babylonjs/core/scene.js').Scene} scene
 */
export function meshFromGeo(name, geo, material, scene) {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = geo.positions;
  vd.normals = geo.normals;
  vd.uvs = geo.uvs;
  vd.indices = geo.indices;
  vd.applyToMesh(mesh, false);
  mesh.material = material;
  /**
   * ビューモデルは常にカメラの目の前にいるので、フラスタムカリングの判定は
   * 無駄なうえ、リグのアニメで AABB が古いままだとチラつく。常時描画に固定。
   */
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}
