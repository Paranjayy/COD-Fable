import { WGSL_NOISE } from './noise.js';

/**
 * SURFACE FORGE — 19 種の手続きサーフェスを 1 本のシェーダで生成する。
 *
 * ## なぜ 1 本にまとめたのか
 *
 * Three.js 版は surfaces-arch / -ground / -metal / -organic の 4 ファイル
 * 1,667 行の GLSL に分かれていた。分ける動機は「エージェントごとにファイルを
 * 所有させる」ためだったが、実際には同じ fbm / voronoi / weathering のコードが
 * 4 箇所にコピーされ、片方だけ直る事故が起きやすい形になっていた。
 *
 * ここでは **ノイズ語彙を noise.js に一本化し、サーフェス差は `kind` と
 * パラメータだけで表現する**。新しいサーフェスを足す作業が「library.js に
 * 数値を 1 行足す」で済み、シェーダを触らずに済むことが多い (SSOT)。
 *
 * ## 出力
 *
 *   rgb = albedo (**線形**。sRGB ではない)
 *   a   = height 0..1 (この後 derive.wgsl が Sobel で法線に変換する)
 *
 * height を albedo と同じパスで出すのは、両者が同じノイズ評価を共有するから。
 * 別パスにすると同じ fbm を 2 回引くことになり、19 サーフェス分では無視できない。
 *
 * ## 座標系
 *
 * `input.vUV` は 0..1 のタイル座標。`uniforms.tile` を掛けて格子座標にする。
 * **周期は必ず `tile` そのもの**を渡すこと — ここがズレると継ぎ目が出る。
 */
export const WGSL_SURFACE = /* wgsl */ `
varying vUV: vec2f;

uniform kind: f32;
uniform seedf: f32;
/** タイル内の格子分割数。周期性の基準になる。 */
uniform tile: vec2f;
/** 主色 (線形)。 */
uniform tint: vec3f;
/** 副色 (線形) — 目地、錆、木目の濃い方など。 */
uniform tint2: vec3f;
/** 汚れ色 (線形)。凹部に溜まる。 */
uniform grime: vec3f;
/** サーフェス固有パラメータ。意味は kind ごとに違う (library.js 参照)。 */
uniform pa: vec4f;
uniform pb: vec4f;
/** 風化の強さ [全体, エッジ摩耗, 凹部の汚れ, 色ムラ]。 */
uniform weather: vec4f;

${WGSL_NOISE}

/** 凹部に汚れを溜める共通処理。height が低いほど grime が濃く乗る。 */
fn applyGrime(col: vec3f, h: f32, amount: f32, g: vec3f) -> vec3f {
  let cav = clamp(1.0 - h, 0.0, 1.0);
  return mix(col, g, clamp(cav * cav * amount, 0.0, 0.92));
}

/** エッジ (height が高い所) の塗装/表層を剥がして下地を出す。 */
fn applyWear(col: vec3f, h: f32, amount: f32, base: vec3f, uv: vec2f, seed: u32) -> vec3f {
  let n = fbm2p(uv * 6.0, vec2f(6.0), 3, 0.5, 2.0, seed + 909u);
  let w = clamp((h - 0.62) * 3.4, 0.0, 1.0) * clamp(n * 1.6, 0.0, 1.0) * amount;
  return mix(col, base, clamp(w, 0.0, 1.0));
}

/**
 * 色ムラの振れ幅。0 のとき完全に無効化できるようにしてある。
 *
 * **ヘルパ関数は必ず main より前に置くこと。** Babylon は WGSL のエントリポイントを
 * 書き換える際、シェーダ末尾に return fragmentOutputs; を注入する。main の後ろに
 * 関数があると、その注入が最後の関数の中に入ってしまい
 * 「return statement type must match its function return type」で落ちる。
 *
 * なお、この JSDoc は WGSL 文字列 (テンプレートリテラル) の中にあるので
 * **バッククォートを書いてはいけない**。書くとリテラルがそこで終端し、
 * 「Unexpected token 'return'」という一見無関係な JS 構文エラーになる。
 */
fn weatherTint(w: f32) -> f32 {
  return w * 0.42;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = input.vUV;
  let per = uniforms.tile;
  let g = uv * per;
  let seed = u32(uniforms.seedf);
  let k = i32(uniforms.kind + 0.5);

  var col = uniforms.tint;
  var h = 0.5;

  // ------------------------------------------------------------ concrete --
  if (k == 0) {
    // 打ちっぱなしコンクリート: 粗い骨材 + 気泡 + 型枠の継ぎ目 + 打ち継ぎムラ。
    let agg = fbm2p(g * 3.0, per * 3.0, 5, 0.55, 2.0, seed);
    let fine = fbm2p(g * 14.0, per * 14.0, 3, 0.5, 2.0, seed + 17u);
    // 気泡 (ブローホール)。voronoi のセル中心付近だけを凹ませる。
    let vo = voronoi2p(g * 22.0, per * 22.0, 1.0, seed + 31u);
    let holes = 1.0 - smoothstep(0.0, 0.16, vo.x) * 0.85;
    // 打ち継ぎ: 水平方向の帯。pa.x が 1 なら床なので帯を消す。
    let pour = fbm2p(vec2f(g.x * 0.35, g.y * 2.2), vec2f(per.x * 0.35, per.y * 2.2), 3, 0.5, 2.0, seed + 47u);
    let bandStrength = select(0.14, 0.0, uniforms.pa.x > 0.5);

    h = 0.62 + (agg - 0.5) * 0.42 + (fine - 0.5) * 0.16 - holes * 0.30;
    h = h - (pour - 0.5) * bandStrength;
    col = mix(uniforms.tint, uniforms.tint2, clamp((agg - 0.35) * 1.5, 0.0, 1.0) * 0.55);
    col = col * (0.86 + fine * 0.28);
    col = applyGrime(col, h, uniforms.weather.z * 0.9, uniforms.grime);
  }
  // --------------------------------------------------------------- brick --
  else if (k == 1) {
    // 段積みレンガ。pa = [列数, 段数, 目地幅, ずらし量]
    let cols = uniforms.pa.x;
    let rows = uniforms.pa.y;
    let mortar = uniforms.pa.z;
    let row = floor(uv.y * rows);
    // 1 段ごとに半個ずらす。row を周期 rows で wrap しないと縦の継ぎ目が出る。
    let offs = (row % 2.0) * uniforms.pa.w;
    let bx = uv.x * cols + offs;
    let by = uv.y * rows;
    let fx = fract(bx);
    let fy = fract(by);
    let id = vec2f(floor(bx), row);
    // 目地マスク。0 = 目地、1 = レンガ面。
    let ex = min(fx, 1.0 - fx);
    let ey = min(fy, 1.0 - fy);
    let brick = smoothstep(0.0, mortar, ex) * smoothstep(0.0, mortar * cols / rows, ey);

    let rnd = hash21p(id, vec2f(cols, rows), seed);
    let face = fbm2p(g * 9.0, per * 9.0, 4, 0.55, 2.0, seed + 5u);
    // 個体差: レンガごとに色と高さを振る。これが無いと「並んだ矩形」に見える。
    let brickCol = mix(uniforms.tint, uniforms.tint2, rnd * 0.85) * (0.82 + face * 0.34);
    let mortarCol = uniforms.grime * (0.9 + face * 0.2);

    h = mix(0.24, 0.80 + (rnd - 0.5) * 0.10, brick) + (face - 0.5) * 0.10 * brick;
    col = mix(mortarCol, brickCol, brick);
    col = applyGrime(col, h, uniforms.weather.z, uniforms.grime);
  }
  // ------------------------------------------------------------- plaster --
  else if (k == 2) {
    // 漆喰: なめらかな下地 + コテ跡 + 剥離してレンガ/コンクリが覗く欠け。
    let trowel = fbm2p(rot2(g * 2.2, 0.6), per * 2.2, 4, 0.5, 2.0, seed);
    let fine = fbm2p(g * 26.0, per * 26.0, 2, 0.5, 2.0, seed + 9u);
    // 剥離: 大きめの ridge を閾値で切って「めくれ」を作る。
    let peelN = ridge2p(g * 1.6, per * 1.6, 4, 0.55, seed + 21u);
    let peel = smoothstep(uniforms.pa.x, uniforms.pa.x + 0.09, peelN) * uniforms.pa.y;

    h = 0.70 + (trowel - 0.5) * 0.20 + (fine - 0.5) * 0.06 - peel * 0.42;
    col = uniforms.tint * (0.90 + trowel * 0.20);
    col = mix(col, uniforms.tint2, peel);
    col = applyGrime(col, h, uniforms.weather.z * 1.1, uniforms.grime);
  }
  // ---------------------------------------------------------------- tile --
  else if (k == 3) {
    let n = uniforms.pa.x;
    let gap = uniforms.pa.y;
    let t = uv * n;
    let f = fract(t);
    let id = floor(t);
    let ex = min(f.x, 1.0 - f.x);
    let ey = min(f.y, 1.0 - f.y);
    let face = smoothstep(0.0, gap, ex) * smoothstep(0.0, gap, ey);
    let rnd = hash21p(id, vec2f(n), seed);
    let glz = fbm2p(g * 18.0, per * 18.0, 3, 0.5, 2.0, seed + 3u);
    // タイルは僅かに反り、目地は深い。反りが無いと平面すぎて CG に見える。
    let bow = (0.5 - length(f - vec2f(0.5))) * 0.10;
    h = mix(0.18, 0.86 + bow, face) + (glz - 0.5) * 0.03;
    col = mix(uniforms.grime, mix(uniforms.tint, uniforms.tint2, rnd * 0.5) * (0.94 + glz * 0.12), face);
    col = applyGrime(col, h, uniforms.weather.z * 1.3, uniforms.grime);
  }
  // ------------------------------------------------------------- asphalt --
  else if (k == 4) {
    let agg = voronoi2p(g * 26.0, per * 26.0, 1.0, seed);
    let fine = fbm2p(g * 40.0, per * 40.0, 3, 0.5, 2.0, seed + 11u);
    let macroN = fbm2p(g * 1.4, per * 1.4, 4, 0.55, 2.0, seed + 29u);
    // ひび。ridge の稜線だけを細く残す。
    let crack = 1.0 - smoothstep(0.0, uniforms.pa.x, ridge2p(g * 2.4, per * 2.4, 4, 0.5, seed + 43u) - uniforms.pa.y);
    h = 0.60 + (1.0 - agg.x) * 0.22 + (fine - 0.5) * 0.14 - crack * 0.34;
    col = mix(uniforms.tint, uniforms.tint2, agg.z * 0.6) * (0.80 + fine * 0.34 + macroN * 0.16);
    col = mix(col, uniforms.grime, crack * 0.7);
  }
  // ---------------------------------------------------------------- sand --
  else if (k == 5) {
    // 風紋 + 粒。風紋は一方向の低周波うねりで作る。
    let ripple = sin((rot2(g, uniforms.pa.z).x) * uniforms.pa.x * 6.28318 + fbm2p(g * 1.2, per * 1.2, 3, 0.5, 2.0, seed) * 6.0);
    let grain = fbm2p(g * 52.0, per * 52.0, 2, 0.5, 2.0, seed + 7u);
    let dune = fbm2p(g * 0.8, per * 0.8, 4, 0.55, 2.0, seed + 13u);
    h = 0.56 + ripple * uniforms.pa.y + (grain - 0.5) * 0.10 + (dune - 0.5) * 0.20;
    col = mix(uniforms.tint, uniforms.tint2, clamp(dune * 1.3, 0.0, 1.0) * 0.5) * (0.88 + grain * 0.24);
  }
  // ---------------------------------------------------------------- dirt --
  else if (k == 6) {
    let clod = voronoi2p(g * 12.0, per * 12.0, 0.9, seed);
    let fine = fbm2p(g * 34.0, per * 34.0, 3, 0.5, 2.0, seed + 19u);
    let macroN = fbm2p(g * 1.8, per * 1.8, 5, 0.55, 2.0, seed + 23u);
    // 乾いてひび割れた粘土。voronoi の境界を溝にする。
    let cracks = 1.0 - smoothstep(0.0, 0.06, clod.y) ;
    h = 0.58 + (1.0 - clod.x) * 0.18 + (fine - 0.5) * 0.16 + (macroN - 0.5) * 0.24 - cracks * uniforms.pa.x;
    col = mix(uniforms.tint, uniforms.tint2, macroN) * (0.82 + fine * 0.30);
    col = applyGrime(col, h, uniforms.weather.z * 0.8, uniforms.grime);
  }
  // -------------------------------------------------------------- gravel --
  else if (k == 7) {
    let v = voronoi2p(g * uniforms.pa.x, per * uniforms.pa.x, 1.0, seed);
    let fine = fbm2p(g * 44.0, per * 44.0, 2, 0.5, 2.0, seed + 3u);
    // 石は丸い: 距離場をドーム状に持ち上げる。
    let stone = 1.0 - smoothstep(0.0, 0.5, v.x);
    h = 0.34 + stone * 0.52 + (fine - 0.5) * 0.10;
    col = mix(uniforms.grime, mix(uniforms.tint, uniforms.tint2, v.z), stone) * (0.84 + fine * 0.28);
  }
  // ----------------------------------------------------------- metal rust --
  else if (k == 8) {
    let base = fbm2p(g * 8.0, per * 8.0, 4, 0.55, 2.0, seed);
    // 錆は斑にしか出ない。閾値で島状に切る。
    let rustN = fbm2p(g * 3.0, per * 3.0, 5, 0.6, 2.0, seed + 37u);
    let rust = smoothstep(uniforms.pa.x, uniforms.pa.x + 0.22, rustN) * uniforms.pa.y;
    let pit = voronoi2p(g * 30.0, per * 30.0, 1.0, seed + 41u);
    let pits = (1.0 - smoothstep(0.0, 0.12, pit.x)) * rust;
    h = 0.72 + (base - 0.5) * 0.10 + rust * 0.14 - pits * 0.34;
    // 錆びた所は膨らみ、健全な金属は平滑。
    col = mix(uniforms.tint, uniforms.tint2, rust) * (0.88 + base * 0.24);
    col = applyGrime(col, h, uniforms.weather.z * 0.7, uniforms.grime);
  }
  // -------------------------------------------------------- metal painted --
  else if (k == 9) {
    let orange = fbm2p(g * 20.0, per * 20.0, 3, 0.5, 2.0, seed); // 塗装のゆず肌
    let dent = fbm2p(g * 2.6, per * 2.6, 4, 0.5, 2.0, seed + 15u);
    // 塗装剥げ。エッジ (height 高) から剥がれるのが本物らしい。
    h = 0.74 + (orange - 0.5) * 0.06 + (dent - 0.5) * 0.18;
    col = uniforms.tint * (0.95 + orange * 0.10);
    col = applyWear(col, h, uniforms.pa.x, uniforms.tint2, g, seed);
    col = applyGrime(col, h, uniforms.weather.z * 0.6, uniforms.grime);
  }
  // -------------------------------------------------------- metal brushed --
  else if (k == 10) {
    // 刷毛目: 一方向に強く引き伸ばしたノイズ。
    let dir = rot2(g, uniforms.pa.z);
    let brush = fbm2p(vec2f(dir.x * uniforms.pa.x, dir.y * 1.0), vec2f(per.x * uniforms.pa.x, per.y), 3, 0.5, 2.0, seed);
    let fine = fbm2p(vec2f(dir.x * 220.0, dir.y * 2.0), vec2f(per.x * 220.0, per.y * 2.0), 2, 0.5, 2.0, seed + 8u);
    h = 0.80 + (brush - 0.5) * 0.10 + (fine - 0.5) * 0.06;
    col = uniforms.tint * (0.92 + brush * 0.14 + fine * 0.06);
  }
  // ---------------------------------------------------------- corrugated --
  else if (k == 11) {
    // 波板。sin の周期はタイル数と一致させる (でないと継ぎ目でズレる)。
    let waves = round(uniforms.pa.x);
    let w = sin(uv.x * waves * 6.28318530718);
    let rustN = fbm2p(g * 4.0, per * 4.0, 4, 0.55, 2.0, seed + 27u);
    let rust = smoothstep(0.52, 0.78, rustN) * uniforms.pa.y;
    let scratch = fbm2p(vec2f(g.x * 2.0, g.y * 90.0), vec2f(per.x * 2.0, per.y * 90.0), 2, 0.5, 2.0, seed + 6u);
    h = 0.55 + w * 0.34 + (scratch - 0.5) * 0.05 - rust * 0.10;
    col = mix(uniforms.tint, uniforms.tint2, rust) * (0.86 + scratch * 0.20 + w * 0.06);
    col = applyGrime(col, h, uniforms.weather.z * 0.8, uniforms.grime);
  }
  // ---------------------------------------------------------------- wood --
  else if (k == 12) {
    // 年輪: 一方向に極端に潰した座標で ridge を引く。
    let dir = rot2(g, uniforms.pa.z);
    let ringUv = vec2f(dir.x * uniforms.pa.x, dir.y * 0.35);
    let ringPer = vec2f(per.x * uniforms.pa.x, per.y * 0.35);
    let warp = fbm2p(dir * 1.4, per * 1.4, 3, 0.5, 2.0, seed + 4u);
    let rings = ridge2p(ringUv + vec2f(warp * 1.6, 0.0), ringPer, 3, 0.5, seed);
    let fibre = fbm2p(vec2f(dir.x * 3.0, dir.y * 160.0), vec2f(per.x * 3.0, per.y * 160.0), 2, 0.5, 2.0, seed + 12u);
    // 節。まばらな voronoi セルを濃く落とす。
    let kn = voronoi2p(dir * uniforms.pa.y, per * uniforms.pa.y, 1.0, seed + 55u);
    let knot = 1.0 - smoothstep(0.0, 0.12, kn.x);
    h = 0.72 - rings * 0.18 + (fibre - 0.5) * 0.08 - knot * 0.22;
    col = mix(uniforms.tint, uniforms.tint2, rings * 0.9);
    col = mix(col, uniforms.tint2 * 0.55, knot * 0.8);
    col = col * (0.88 + fibre * 0.22);
    col = applyGrime(col, h, uniforms.weather.z * 0.7, uniforms.grime);
  }
  // -------------------------------------------------------------- fabric --
  else if (k == 13) {
    // 平織り。縦糸と横糸を市松に組む。
    let n = uniforms.pa.x;
    let t = uv * n;
    let f = fract(t);
    let warpT = sin(f.x * 3.14159265);
    let weftT = sin(f.y * 3.14159265);
    let checker = step(0.5, fract((floor(t.x) + floor(t.y)) * 0.5));
    let thread = mix(warpT, weftT, checker);
    let fuzz = fbm2p(g * 90.0, per * 90.0, 2, 0.5, 2.0, seed);
    h = 0.42 + thread * 0.40 + (fuzz - 0.5) * 0.10;
    col = mix(uniforms.tint, uniforms.tint2, checker * 0.35) * (0.84 + thread * 0.22 + fuzz * 0.14);
  }
  // -------------------------------------------------------------- burlap --
  else if (k == 14) {
    // 麻袋: fabric より糸が太くて不揃い。糸ごとに太さを振る。
    let n = uniforms.pa.x;
    let t = uv * n;
    let f = fract(t);
    let jx = hash21p(vec2f(floor(t.x), 0.0), vec2f(n, 1.0), seed) * 0.4 + 0.8;
    let jy = hash21p(vec2f(0.0, floor(t.y)), vec2f(1.0, n), seed + 2u) * 0.4 + 0.8;
    let warpT = sin(clamp(f.x * jx, 0.0, 1.0) * 3.14159265);
    let weftT = sin(clamp(f.y * jy, 0.0, 1.0) * 3.14159265);
    let checker = step(0.5, fract((floor(t.x) + floor(t.y)) * 0.5));
    let thread = mix(warpT, weftT, checker);
    let fuzz = fbm2p(g * 60.0, per * 60.0, 3, 0.5, 2.0, seed + 1u);
    h = 0.38 + thread * 0.46 + (fuzz - 0.5) * 0.16;
    col = mix(uniforms.tint, uniforms.tint2, fuzz * 0.5) * (0.78 + thread * 0.30 + fuzz * 0.16);
    col = applyGrime(col, h, uniforms.weather.z * 0.9, uniforms.grime);
  }
  // ------------------------------------------------------------- foliage --
  else if (k == 15) {
    // 葉の塊。voronoi のセルを 1 枚の葉に見立て、葉脈を入れる。
    let v = voronoi2p(g * uniforms.pa.x, per * uniforms.pa.x, 1.0, seed);
    let leaf = 1.0 - smoothstep(0.30, 0.52, v.x);
    let vein = abs(sin((v.x * 18.0 + v.z * 6.28318)));
    let shade = fbm2p(g * 2.2, per * 2.2, 4, 0.55, 2.0, seed + 14u);
    h = 0.40 + leaf * 0.42 - vein * 0.06 * leaf;
    col = mix(uniforms.grime, mix(uniforms.tint, uniforms.tint2, v.z), leaf);
    col = col * (0.72 + shade * 0.50);
  }
  // -------------------------------------------------------------- rubber --
  else if (k == 16) {
    // タイヤ的なブロックパターン + 微細な梨地。
    let n = uniforms.pa.x;
    let t = uv * n;
    let f = fract(t);
    let ex = min(f.x, 1.0 - f.x);
    let ey = min(f.y, 1.0 - f.y);
    let block = smoothstep(0.0, uniforms.pa.y, ex) * smoothstep(0.0, uniforms.pa.y, ey);
    let pebble = fbm2p(g * 70.0, per * 70.0, 2, 0.5, 2.0, seed);
    h = mix(0.28, 0.82, block) + (pebble - 0.5) * 0.08;
    col = uniforms.tint * (0.86 + pebble * 0.18 + block * 0.08);
  }
  // --------------------------------------------------------------- glass --
  else {
    // ガラスは「ほぼ平ら」でよい。汚れと僅かな歪みだけを持たせる。
    let smear = fbm2p(g * 3.2, per * 3.2, 4, 0.5, 2.0, seed);
    let dust = fbm2p(g * 40.0, per * 40.0, 2, 0.5, 2.0, seed + 10u);
    h = 0.90 + (smear - 0.5) * 0.03;
    col = mix(uniforms.tint, uniforms.grime, clamp(smear * uniforms.pa.x + dust * uniforms.pa.y, 0.0, 0.6));
  }

  // ------------------------------------------------------------- 共通処理 --
  // 大きなスケールの色ムラ。これが無いと「1 枚のタイルを敷いた」ことが
  // 遠景で必ずバレる (README の品質バー「Nothing perfectly repeated」)。
  let macroVar = fbm2p(g * 0.35, per * 0.35, 4, 0.6, 2.0, seed + 777u);
  col = col * (1.0 + (macroVar - 0.5) * weatherTint(uniforms.weather.w));

  h = clamp(h, 0.0, 1.0);
  fragmentOutputs.color = vec4f(max(col, vec3f(0.0)), h);
}
`;
