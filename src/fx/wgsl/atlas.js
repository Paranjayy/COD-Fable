/**
 * パーティクル / デカールのアトラスを手続き生成する WGSL。
 *
 * 4x4 のタイルに 16 種を焼く。画像アセットを持たないので、煙も火花も弾痕も
 * すべてここで作る。
 *
 * ## 出力の規約 (これを崩すとパーティクルシェーダ側が壊れる)
 *
 *   rgb = 色の乗算項 (1.0 が素通し)。粒子の色は spawn 側が決めるので、ここでは
 *         「模様」だけを持つ
 *   a   = 密度。0 で完全に透明、1 で不透明
 *
 * fragment 側は `tex.a` を密度として self-shadowing にも使い、`tex.r` の勾配から
 * 偽の法線を曲げている (particles.js の LIT パス)。したがって **r チャンネルには
 * 密度と相関のある模様を入れること**。真っ白にすると煙の内部構造が消える。
 */

/** パーティクル用 4x4 アトラス。タイル ID は fx/atlas.js の P と対応。 */
export const WGSL_PARTICLE_ATLAS = /* wgsl */ `
varying vUV: vec2f;
uniform seedf: f32;

fn hash11u(x: u32) -> u32 {
  var h = x;
  h ^= h >> 16u; h *= 0x7feb352du;
  h ^= h >> 15u; h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

fn hash21(p: vec2f, seed: u32) -> f32 {
  let w = vec2u(vec2i(floor(p)) + vec2i(4096, 4096));
  return f32(hash11u(w.x ^ hash11u(w.y ^ seed))) / 4294967296.0;
}

fn vnoise(uv: vec2f, seed: u32) -> f32 {
  let i = floor(uv);
  let f = uv - i;
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i, seed);
  let b = hash21(i + vec2f(1.0, 0.0), seed);
  let c = hash21(i + vec2f(0.0, 1.0), seed);
  let d = hash21(i + vec2f(1.0, 1.0), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(uv: vec2f, oct: i32, seed: u32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var p = uv;
  var n = 0.0;
  for (var i = 0; i < oct; i = i + 1) {
    s = s + vnoise(p, seed + u32(i) * 71u) * a;
    n = n + a;
    a = a * 0.5;
    p = p * 2.0;
  }
  return s / max(n, 1e-5);
}

/** タイル中心からの正規化距離。0=中心, 1=縁。 */
fn rad(uv: vec2f) -> f32 {
  return length(uv - vec2f(0.5)) * 2.0;
}

/** 煙・埃の塊。ふわっとした縁と内部のむらを持つ。 */
fn puff(uv: vec2f, softness: f32, detail: f32, seed: u32) -> vec2f {
  let n = fbm(uv * detail, 4, seed);
  // 縁を fbm で食い破る。真円のままだと「点」に見えて煙にならない。
  let r = rad(uv) + (n - 0.5) * 0.55;
  let a = smoothstep(1.0, softness, r);
  // r チャンネルに密度と相関する模様を入れる (LIT パスが勾配を使う)。
  let tone = 0.62 + n * 0.5;
  return vec2f(tone, a * a);
}

/** 細い筋。火花の尾や飛散物に使う。縦方向 (v) に伸びる。 */
fn streak(uv: vec2f, width: f32, seed: u32) -> vec2f {
  let dx = abs(uv.x - 0.5) * 2.0;
  let dy = abs(uv.y - 0.5) * 2.0;
  let core = smoothstep(width, 0.0, dx);
  let along = smoothstep(1.0, 0.15, dy);
  let a = core * along;
  return vec2f(0.9 + hash21(uv * 64.0, seed) * 0.2, a);
}

/** 硬い破片。多角形に近いシルエット。 */
fn chip(uv: vec2f, sides: f32, seed: u32) -> vec2f {
  let p = uv - vec2f(0.5);
  let ang = atan2(p.y, p.x);
  let r = length(p) * 2.0;
  // 角度で半径を刻んで多角形にする。乱数で歪ませて「割れた」形にする。
  // 変数名に step を使わないこと — WGSL の組み込み関数 step() を隠してしまう。
  let sector = 6.28318530718 / sides;
  let k = floor(ang / sector);
  let jitter = 0.62 + hash21(vec2f(k, 0.0), seed) * 0.36;
  let a = smoothstep(jitter, jitter - 0.14, r);
  return vec2f(0.85, a);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  // 4x4 のどのタイルか。
  let g = input.vUV * 4.0;
  let cell = floor(g);
  let uv = g - cell;
  let id = i32(cell.y) * 4 + i32(cell.x);
  let seed = u32(uniforms.seedf) + u32(id) * 9176u;

  var o = vec2f(1.0, 0.0);

  if (id == 0) {          // SMOKE_A — 濃い煙
    o = puff(uv, 0.05, 3.0, seed);
  } else if (id == 1) {   // SMOKE_B — もう少し崩れた煙
    o = puff(uv, 0.02, 4.5, seed);
    o.y = o.y * 0.9;
  } else if (id == 2) {   // WISP — 薄くたなびく煙
    let p = puff(uv, 0.0, 5.0, seed);
    o = vec2f(p.x, p.y * 0.45);
  } else if (id == 3) {   // DUST — 細かい埃
    let p = puff(uv, 0.12, 7.0, seed);
    o = vec2f(p.x * 1.05, p.y * 0.8);
  } else if (id == 4) {   // SPARK — 点の火花
    let r = rad(uv);
    o = vec2f(1.0, smoothstep(0.55, 0.0, r));
  } else if (id == 5) {   // STREAK — 尾を引く火花
    o = streak(uv, 0.22, seed);
  } else if (id == 6) {   // FLASH_LOBE — マズルフラッシュの花弁
    let p = uv - vec2f(0.5);
    let ang = atan2(p.y, p.x);
    let r = length(p) * 2.0;
    // 4 枚の花弁。実銃のマズルフラッシュはブレーキのポート数で形が決まる。
    let petal = 0.45 + 0.5 * abs(cos(ang * 2.0));
    o = vec2f(1.0, smoothstep(petal, petal * 0.2, r));
  } else if (id == 7) {   // FLASH_CORE — 芯の白熱部
    let r = rad(uv);
    o = vec2f(1.0, smoothstep(0.42, 0.0, r));
  } else if (id == 8) {   // CHIP — コンクリ片
    o = chip(uv, 6.0, seed);
  } else if (id == 9) {   // SPLINTER — 木片。細長い
    let p = uv - vec2f(0.5);
    let a = smoothstep(0.5, 0.34, abs(p.x) * 4.0 + abs(p.y) * 1.1);
    o = vec2f(0.8, a);
  } else if (id == 10) {  // DROPLET — 液滴
    let p = (uv - vec2f(0.5)) * vec2f(2.4, 2.0);
    o = vec2f(1.0, smoothstep(0.6, 0.1, length(p)));
  } else if (id == 11) {  // MIST — きわめて薄い霧
    let p = puff(uv, 0.0, 2.2, seed);
    o = vec2f(p.x, p.y * 0.28);
  } else if (id == 12) {  // SPLASH — 水の跳ね
    let p = uv - vec2f(0.5, 0.2);
    let a = smoothstep(0.55, 0.1, length(p * vec2f(1.6, 1.0)));
    o = vec2f(1.0, a * smoothstep(0.0, 0.3, uv.y));
  } else if (id == 13) {  // RING — 衝撃波のリング
    let r = rad(uv);
    o = vec2f(1.0, smoothstep(0.06, 0.0, abs(r - 0.78)));
  } else if (id == 14) {  // FIRE — 炎
    let n = fbm(uv * 4.0 + vec2f(0.0, -uv.y * 2.0), 4, seed);
    let r = rad(uv) + (n - 0.5) * 0.7;
    o = vec2f(0.7 + n * 0.6, smoothstep(1.0, 0.1, r));
  } else {                // MOTE — 舞う塵
    let r = rad(uv);
    o = vec2f(1.0, smoothstep(0.9, 0.2, r) * 0.5);
  }

  fragmentOutputs.color = vec4f(vec3f(o.x), o.y);
}
`;

/** デカール用 4x4 アトラス。タイル ID は fx/atlas.js の D と対応。 */
export const WGSL_DECAL_ATLAS = /* wgsl */ `
varying vUV: vec2f;
uniform seedf: f32;

fn hash11u(x: u32) -> u32 {
  var h = x;
  h ^= h >> 16u; h *= 0x7feb352du;
  h ^= h >> 15u; h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

fn hash21(p: vec2f, seed: u32) -> f32 {
  let w = vec2u(vec2i(floor(p)) + vec2i(4096, 4096));
  return f32(hash11u(w.x ^ hash11u(w.y ^ seed))) / 4294967296.0;
}

fn vnoise(uv: vec2f, seed: u32) -> f32 {
  let i = floor(uv);
  let f = uv - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i, seed), hash21(i + vec2f(1.0, 0.0), seed), u.x),
    mix(hash21(i + vec2f(0.0, 1.0), seed), hash21(i + vec2f(1.0, 1.0), seed), u.x),
    u.y
  );
}

fn fbm(uv: vec2f, oct: i32, seed: u32) -> f32 {
  var s = 0.0; var a = 0.5; var p = uv; var n = 0.0;
  for (var i = 0; i < oct; i = i + 1) {
    s = s + vnoise(p, seed + u32(i) * 71u) * a;
    n = n + a; a = a * 0.5; p = p * 2.0;
  }
  return s / max(n, 1e-5);
}

/** 放射状のひび。中心から線が伸びる。 */
fn radialCracks(uv: vec2f, count: f32, seed: u32) -> f32 {
  let p = uv - vec2f(0.5);
  let ang = atan2(p.y, p.x);
  let r = length(p) * 2.0;
  let k = ang * count / 6.28318530718;
  let f = abs(fract(k) - 0.5) * 2.0;
  // 中心ほど太く、外へ行くほど細く消える。
  let w = 0.16 * (1.0 - r) + 0.02;
  let line = smoothstep(w, 0.0, f * (0.3 + r));
  return line * smoothstep(1.0, 0.15, r);
}

/** タイル中心からの正規化距離。**bulletHole より前に置くこと** — WGSL は関数の
 *  前方参照を許さないため、後ろに置くと "unresolved identifier" で落ちる。 */
fn rad2(uv: vec2f) -> f32 {
  return length(uv - vec2f(0.5)) * 2.0;
}

/**
 * 弾痕。中心の穴 + 周囲の欠け + 煤。
 *
 * holeR は穴の半径、spallR は欠けの広がり。素材によって比率が違う
 * (コンクリは欠けが広く、金属は穴が主体で欠けが狭い)。
 */
fn bulletHole(uv: vec2f, holeR: f32, spallR: f32, roughness: f32, seed: u32) -> vec2f {
  let n = fbm(uv * 7.0, 4, seed);
  let r = rad2(uv) + (n - 0.5) * roughness;
  let hole = smoothstep(holeR, holeR * 0.55, r);
  let spall = smoothstep(spallR, holeR, r) * (0.35 + n * 0.5);
  let a = clamp(hole + spall * 0.75, 0.0, 1.0);
  // 穴の中は黒、欠けは下地より少し暗い。
  let tone = mix(0.55 + n * 0.35, 0.05, hole);
  return vec2f(tone, a);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let g = input.vUV * 4.0;
  let cell = floor(g);
  let uv = g - cell;
  let id = i32(cell.y) * 4 + i32(cell.x);
  let seed = u32(uniforms.seedf) + u32(id) * 4517u;

  var o = vec2f(1.0, 0.0);

  if (id == 0) {          // HOLE_CONCRETE
    o = bulletHole(uv, 0.30, 0.92, 0.42, seed);
  } else if (id == 1) {   // HOLE_CONCRETE_B — 別の割れ方
    o = bulletHole(uv, 0.26, 0.86, 0.55, seed + 13u);
  } else if (id == 2) {   // HOLE_METAL — 穴主体、欠けは狭い
    let b = bulletHole(uv, 0.24, 0.44, 0.22, seed);
    // 縁がめくれて明るく光る。
    let lip = smoothstep(0.30, 0.24, rad2(uv)) - smoothstep(0.24, 0.20, rad2(uv));
    o = vec2f(b.x + lip * 0.8, max(b.y, lip));
  } else if (id == 3) {   // HOLE_WOOD — 繊維が裂ける
    let b = bulletHole(uv, 0.24, 0.70, 0.30, seed);
    let fibre = fbm(vec2f(uv.x * 3.0, uv.y * 40.0), 2, seed) ;
    o = vec2f(b.x * (0.7 + fibre * 0.6), b.y);
  } else if (id == 4) {   // HOLE_PLASTER — 大きく崩れる
    o = bulletHole(uv, 0.22, 0.98, 0.62, seed);
  } else if (id == 5) {   // GLASS_CRACK
    let c = radialCracks(uv, 11.0, seed);
    // 同心円のひびも足す。放射だけだと蜘蛛の巣に見えない。
    let r = rad2(uv);
    let rings = smoothstep(0.04, 0.0, abs(fract(r * 3.0 + fbm(uv * 5.0, 3, seed)) - 0.5) - 0.42);
    o = vec2f(1.0, clamp(c + rings * smoothstep(1.0, 0.2, r) * 0.5, 0.0, 1.0));
  } else if (id == 6) {   // BLOOD_A
    let n = fbm(uv * 5.0, 4, seed);
    let r = rad2(uv) + (n - 0.5) * 0.8;
    o = vec2f(0.32 + n * 0.25, smoothstep(1.0, 0.35, r));
  } else if (id == 7) {   // BLOOD_B — 飛沫が散る
    let n = fbm(uv * 9.0, 4, seed + 7u);
    let r = rad2(uv) + (n - 0.5) * 1.3;
    o = vec2f(0.30 + n * 0.22, smoothstep(1.0, 0.15, r) * 0.9);
  } else if (id == 8) {   // SCORCH — 焦げ
    let n = fbm(uv * 3.5, 5, seed);
    let r = rad2(uv) + (n - 0.5) * 0.6;
    o = vec2f(0.06 + n * 0.10, smoothstep(1.0, 0.1, r) * 0.85);
  } else if (id == 9) {   // IMPACT_DIRT
    let n = fbm(uv * 6.0, 4, seed);
    let r = rad2(uv) + (n - 0.5) * 0.7;
    o = vec2f(0.42 + n * 0.3, smoothstep(1.0, 0.25, r) * 0.8);
  } else if (id == 10) {  // IMPACT_SAND — 浅く広い
    let n = fbm(uv * 4.0, 3, seed);
    let r = rad2(uv) + (n - 0.5) * 0.5;
    o = vec2f(0.75 + n * 0.25, smoothstep(1.0, 0.3, r) * 0.6);
  } else if (id == 11) {  // SCRAPE — 擦過痕。横に伸びる
    let p = uv - vec2f(0.5);
    let n = fbm(vec2f(uv.x * 20.0, uv.y * 3.0), 3, seed);
    let a = smoothstep(0.5, 0.1, abs(p.y) * 3.4 + (0.5 - n) * 0.5) * smoothstep(1.0, 0.4, abs(p.x) * 2.0);
    o = vec2f(0.9 + n * 0.3, a);
  } else if (id == 12) {  // RIPPLE — 水面の波紋
    let r = rad2(uv);
    o = vec2f(1.0, smoothstep(0.05, 0.0, abs(r - 0.7)) * smoothstep(1.0, 0.5, r));
  } else if (id == 13) {  // HOLE_GLASS
    let c = radialCracks(uv, 9.0, seed);
    let b = bulletHole(uv, 0.13, 0.20, 0.15, seed);
    o = vec2f(1.0, clamp(c * 0.8 + b.y, 0.0, 1.0));
  } else if (id == 14) {  // SMUDGE — 煤の薄い汚れ
    let n = fbm(uv * 3.0, 4, seed);
    let r = rad2(uv) + (n - 0.5) * 0.9;
    o = vec2f(0.18 + n * 0.2, smoothstep(1.0, 0.2, r) * 0.45);
  } else {                // TEAR — 布の裂け
    let p = uv - vec2f(0.5);
    let n = fbm(vec2f(uv.y * 12.0, 0.0), 3, seed);
    let a = smoothstep(0.14, 0.0, abs(p.x + (n - 0.5) * 0.3)) * smoothstep(1.0, 0.3, abs(p.y) * 2.0);
    o = vec2f(0.5, a);
  }

  fragmentOutputs.color = vec4f(vec3f(o.x), o.y);
}
`;
