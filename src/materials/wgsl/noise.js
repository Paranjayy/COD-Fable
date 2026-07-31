/**
 * WGSL noise library — the shared vocabulary every procedural surface is built from.
 *
 * ## なぜ「周期的 (periodic)」ノイズしか使わないのか
 *
 * このゲームには画像アセットが 1 枚も無く、すべてのテクスチャは 1 枚のタイルを
 * 敷き詰めて表現される。タイルの継ぎ目が見えた瞬間に「手続き生成された絵」に
 * 見えてしまい、README の品質バーにある「No flat/untextured surfaces」以前の
 * 問題になる。
 *
 * したがって **格子ハッシュは必ず周期 `p` で wrap する**。`hash22p` / `vnoise2p`
 * / `fbm2p` / `voronoi2p` はすべて周期を引数に取り、UV が 0→1 を跨いだときに
 * 同じ値を返す。周期を取らない版は意図的に用意していない — 「うっかり非周期の
 * ノイズを混ぜて継ぎ目を作る」事故を型で防げない以上、選択肢を置かないのが一番安全。
 *
 * ## 決定性
 *
 * ハッシュは整数演算だけで書いてある。`sin()` ベースのハッシュ (よくある
 * `fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453)`) は GPU ベンダによって
 * `sin` の精度が違い、**同じコードが別マシンで別のテクスチャを作る**。この
 * リポジトリはピクセル一致をゲートにしているので、それは許容できない。
 */
export const WGSL_NOISE = /* wgsl */ `
// ---------------------------------------------------------------- hashing --

fn hash11u(x: u32) -> u32 {
  var h = x;
  h ^= h >> 16u; h *= 0x7feb352du;
  h ^= h >> 15u; h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

fn hash21u(p: vec2u) -> u32 {
  return hash11u(p.x ^ hash11u(p.y * 0x9e3779b9u));
}

/** 0..1 のスカラ。格子座標 p を周期 per で wrap してから引く。 */
fn hash21p(p: vec2f, per: vec2f, seed: u32) -> f32 {
  let w = vec2u(vec2i(p - floor(p / per) * per));
  return f32(hash21u(w ^ vec2u(seed, seed * 0x85ebca6bu))) / 4294967296.0;
}

/** 0..1 の 2 成分。 */
fn hash22p(p: vec2f, per: vec2f, seed: u32) -> vec2f {
  let w = vec2u(vec2i(p - floor(p / per) * per));
  let h = hash21u(w ^ vec2u(seed, seed * 0x85ebca6bu));
  return vec2f(f32(h & 0xffffu) / 65536.0, f32(h >> 16u) / 65536.0);
}

/** -1..1 の単位ベクトルに近い勾配。gradient noise 用。 */
fn grad22p(p: vec2f, per: vec2f, seed: u32) -> vec2f {
  let a = hash21p(p, per, seed) * 6.28318530718;
  return vec2f(cos(a), sin(a));
}

// ------------------------------------------------------------ value noise --

fn fade2(t: vec2f) -> vec2f {
  // quintic。cubic だと 2 階微分が不連続で、height→normal の Sobel を掛けた
  // ときに格子が縞になって出る。
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

/** 周期 per の value noise。0..1。 */
fn vnoise2p(uv: vec2f, per: vec2f, seed: u32) -> f32 {
  let i = floor(uv);
  let f = fade2(uv - i);
  let a = hash21p(i + vec2f(0.0, 0.0), per, seed);
  let b = hash21p(i + vec2f(1.0, 0.0), per, seed);
  let c = hash21p(i + vec2f(0.0, 1.0), per, seed);
  let d = hash21p(i + vec2f(1.0, 1.0), per, seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** 周期 per の gradient (Perlin) noise。-1..1。value より稜線が自然。 */
fn gnoise2p(uv: vec2f, per: vec2f, seed: u32) -> f32 {
  let i = floor(uv);
  let f = uv - i;
  let u = fade2(f);
  let g00 = grad22p(i + vec2f(0.0, 0.0), per, seed);
  let g10 = grad22p(i + vec2f(1.0, 0.0), per, seed);
  let g01 = grad22p(i + vec2f(0.0, 1.0), per, seed);
  let g11 = grad22p(i + vec2f(1.0, 1.0), per, seed);
  let n00 = dot(g00, f - vec2f(0.0, 0.0));
  let n10 = dot(g10, f - vec2f(1.0, 0.0));
  let n01 = dot(g01, f - vec2f(0.0, 1.0));
  let n11 = dot(g11, f - vec2f(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y) * 1.4;
}

/** 周期 fbm。octaves ごとに周期も倍にしないと継ぎ目が出る点に注意。 */
fn fbm2p(uv: vec2f, per: vec2f, octaves: i32, gain: f32, lac: f32, seed: u32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var p = uv;
  var pp = per;
  for (var o = 0; o < octaves; o = o + 1) {
    sum = sum + vnoise2p(p, pp, seed + u32(o) * 131u) * amp;
    norm = norm + amp;
    amp = amp * gain;
    p = p * lac;
    pp = pp * lac;
  }
  return sum / max(norm, 1e-5);
}

/** 稜線ノイズ。ひび割れ・岩肌・木目の芯に使う。0..1。 */
fn ridge2p(uv: vec2f, per: vec2f, octaves: i32, gain: f32, seed: u32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var p = uv;
  var pp = per;
  for (var o = 0; o < octaves; o = o + 1) {
    let n = 1.0 - abs(gnoise2p(p, pp, seed + u32(o) * 197u));
    sum = sum + n * n * amp;
    norm = norm + amp;
    amp = amp * gain;
    p = p * 2.0;
    pp = pp * 2.0;
  }
  return sum / max(norm, 1e-5);
}

// ---------------------------------------------------------------- voronoi --

/**
 * 周期 voronoi。戻り値は:
 *   x = 最近セルまでの距離 (0..~1)
 *   y = 2 番目に近いセルとの距離差 (= セル境界の鋭さ。石の目地やひび割れに使う)
 *   z = 最近セルの ID を 0..1 に写したもの (セルごとに色を変えるのに使う)
 */
fn voronoi2p(uv: vec2f, per: vec2f, jitter: f32, seed: u32) -> vec3f {
  let i = floor(uv);
  let f = uv - i;
  var d1 = 8.0;
  var d2 = 8.0;
  var id = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let g = vec2f(f32(x), f32(y));
      let o = hash22p(i + g, per, seed);
      let r = g + (0.5 + (o - 0.5) * jitter) - f;
      let d = dot(r, r);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id = o.x;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return vec3f(sqrt(d1), sqrt(d2) - sqrt(d1), id);
}

// ------------------------------------------------------------------ misc --

fn remap(v: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
  return c + (d - c) * clamp((v - a) / max(b - a, 1e-5), 0.0, 1.0);
}

/** 0..1 を中心 0.5 でコントラスト調整。k>1 でハイコントラスト。 */
fn contrast(v: f32, k: f32) -> f32 {
  return clamp((v - 0.5) * k + 0.5, 0.0, 1.0);
}

/** 2D 回転。木目や刷毛目の向きを surface ごとに変える。 */
fn rot2(uv: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
}

/**
 * sRGB の 16 進を線形に。ライブラリの色指定は人間が読める 0xRRGGBB のままに
 * したいが、PBR の albedo は線形でなければならない。変換をシェーダ側に置くと
 * 「どこで変換したか分からなくなる」ので、CPU 側 (library.js) で線形化して
 * 渡す方針にしてある。この関数はシェーダ内で色を混ぜる時の補助用。
 */
fn srgbToLinear(c: vec3f) -> vec3f {
  return select(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), c > vec3f(0.04045));
}
`;
