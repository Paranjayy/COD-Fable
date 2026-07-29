/**
 * 大気散乱の WGSL 実装 — 空ドームと環境マップの両方をこれ 1 本で描く。
 *
 * ## モデル
 *
 * Rayleigh (分子散乱、青を強く散らす) + Mie (エアロゾル散乱、太陽の周りのハロ) を
 * 単一散乱で解く。多重散乱は解かず、地平線付近の明るさを経験的な項で補う — 実測に
 * 基づく多重散乱 LUT を回すほどの予算は無く、単一散乱だけだと日没時の空が不自然に
 * 暗くなるため。
 *
 * 光学的深さは指数分布大気を球殻としてレイマーチする。地表を平面近似すると
 * 日の出/日没で破綻する (視線が大気を抜ける距離が無限大になる) ので、必ず球で解く。
 *
 * ## なぜ空を「テクスチャに焼かない」のか
 *
 * 時刻が動くたびに焼き直しが要るうえ、焼いた瞬間に解像度で量子化される。空は
 * 画面の広い面積を占め、しかもグラデーションが緩いので、バンディングが最も出やすい。
 * フラグメントで解いてディザを掛けるほうが安い。
 */
export const WGSL_ATMOSPHERE = /* wgsl */ `
// 地球規模の定数 (m)。実寸で解くことで日没の色が自然に出る。
const R_GROUND: f32 = 6360000.0;
const R_ATMOS:  f32 = 6420000.0;
// 尺度高さ: 大気密度が 1/e になる高度。
const H_RAYLEIGH: f32 = 8000.0;
const H_MIE: f32 = 1200.0;

// 散乱係数 (1/m)。RGB 波長 680/550/440nm に対応。
const BETA_RAYLEIGH: vec3f = vec3f(5.8e-6, 13.5e-6, 33.1e-6);
const BETA_MIE: vec3f = vec3f(21e-6, 21e-6, 21e-6);
// Mie の前方散乱の強さ。0.76 は晴天の実測に近い。
const MIE_G: f32 = 0.76;

/** 視線と大気球の交差。戻り値 x=入口, y=出口。交差しなければ y<0。 */
fn raySphere(origin: vec3f, dir: vec3f, radius: f32) -> vec2f {
  let b = dot(origin, dir);
  let c = dot(origin, origin) - radius * radius;
  let d = b * b - c;
  if (d < 0.0) { return vec2f(1.0, -1.0); }
  let s = sqrt(d);
  return vec2f(-b - s, -b + s);
}

fn rayleighPhase(mu: f32) -> f32 {
  return 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
}

fn miePhase(mu: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * mu;
  return 3.0 / (8.0 * 3.14159265) * ((1.0 - g2) * (1.0 + mu * mu))
       / ((2.0 + g2) * pow(max(denom, 1e-4), 1.5));
}

/**
 * 太陽方向への光学的深さ。8 ステップで十分 — ここを増やしても日没の色はほぼ
 * 変わらず、地平線の暗部だけが僅かに動く。
 */
fn opticalDepthToSun(pos: vec3f, sunDir: vec3f) -> vec2f {
  let t = raySphere(pos, sunDir, R_ATMOS);
  if (t.y < 0.0) { return vec2f(1e9); }
  let steps = 8;
  let dt = t.y / f32(steps);
  var depth = vec2f(0.0);
  for (var i = 0; i < steps; i = i + 1) {
    let p = pos + sunDir * (f32(i) + 0.5) * dt;
    let h = max(0.0, length(p) - R_GROUND);
    depth = depth + vec2f(exp(-h / H_RAYLEIGH), exp(-h / H_MIE)) * dt;
  }
  return depth;
}

/**
 * 視線方向の空の色。
 *
 * eye は地表からの高度を足した位置、dir は視線、sunDir は太陽方向。
 * 戻り値は **線形 HDR** — トーンマップは render 側の責務。
 */
fn skyRadiance(eye: vec3f, dir: vec3f, sunDir: vec3f, sunIntensity: f32, turbidity: f32) -> vec3f {
  let atmos = raySphere(eye, dir, R_ATMOS);
  if (atmos.y < 0.0) { return vec3f(0.0); }

  /**
   * 地平線より下の視線について。
   *
   * 素直に「地面に当たったらそこで打ち切る」と、観測点が地表 +1m しかないため
   * 下向きの視線は **ほぼ即座に地面に当たり積分がゼロになる**。結果として空
   * ドームの下半分が真っ黒になり、しかも上半分との境界が硬い線として出る。
   *
   * このドームの下半分はワールドジオメトリでほぼ隠れるので、ここでは打ち切らず
   * 「地平線方向の色をそのまま延長する」ことにする。視線の y を僅かに持ち上げて
   * 積分することで、地平線の色が下方向へ連続的に伸びる。物理的には正しくないが、
   * 隠れる領域のために球面積分を厳密に解く価値はない。
   */
  var d = dir;
  if (d.y < 0.0) {
    d = normalize(vec3f(d.x, mix(0.0, 0.02, clamp(-d.y * 4.0, 0.0, 1.0)), d.z));
  }
  let tMax = atmos.y;

  let steps = 16;
  let dt = tMax / f32(steps);
  let mu = dot(d, sunDir);
  let pr = rayleighPhase(mu);
  let pm = miePhase(mu, MIE_G);

  // 濁度は Mie 散乱の量として効く。砂塵の多い街の空気を表現するのに使う。
  let betaMie = BETA_MIE * turbidity;

  var sumR = vec3f(0.0);
  var sumM = vec3f(0.0);
  var depth = vec2f(0.0);

  for (var i = 0; i < steps; i = i + 1) {
    let p = eye + d * ((f32(i) + 0.5) * dt);
    let h = max(0.0, length(p) - R_GROUND);
    let dens = vec2f(exp(-h / H_RAYLEIGH), exp(-h / H_MIE)) * dt;
    depth = depth + dens;

    let dSun = opticalDepthToSun(p, sunDir);
    // 視線方向の減衰 + 太陽方向の減衰。両方を掛けたものが透過率。
    let tau = BETA_RAYLEIGH * (depth.x + dSun.x) + betaMie * 1.1 * (depth.y + dSun.y);
    let trans = exp(-tau);

    sumR = sumR + trans * dens.x;
    sumM = sumM + trans * dens.y;
  }

  var col = (sumR * BETA_RAYLEIGH * pr + sumM * betaMie * pm) * sunIntensity;

  /**
   * 多重散乱の近似。
   *
   * 単一散乱だけだと、太陽が地平線に近いとき空全体が不自然に暗く沈む (現実には
   * 大気中で何度も散乱した光が空を満たす)。ここでは「Rayleigh の積分値に太陽高度で
   * 減衰する定数を掛けたもの」を足すだけの安価な近似を使う。物理的に正しくはないが、
   * 日没の絵が破綻しない最小限の補正。
   */
  let sunUp = clamp(sunDir.y, 0.0, 1.0);
  let ambient = sumR * BETA_RAYLEIGH * sunIntensity * (0.16 + 0.28 * sunUp);
  col = col + ambient;

  return max(col, vec3f(0.0));
}

/**
 * 太陽円板。物理的な視半径は 0.267 度だが、そのまま描くと 1px 未満になり
 * TAA でちらつく。少し太らせたうえで縁を滑らかに落とす。
 */
fn sunDisc(dir: vec3f, sunDir: vec3f, intensity: f32) -> vec3f {
  let mu = dot(dir, sunDir);
  // cos(0.6deg) ≈ 0.999945
  let edge = smoothstep(0.99989, 0.999955, mu);
  return vec3f(edge * intensity);
}

/**
 * ディザ。空のグラデーションは画面の広い面積を緩やかに変化するため、8bit 出力では
 * 必ずバンディングが出る。±0.5/255 の雑音を足して量子化境界を散らす。
 *
 * ハッシュは整数演算で書く。materials/wgsl/noise.js と同じ理由で、sin ベースの
 * ハッシュは GPU ベンダごとに精度が違い、同じコードが別マシンで別の絵を出す。
 * ディザは振幅こそ小さいが全画素に乗るので、ピクセル一致ゲートには致命的。
 *
 * 引数はピクセル座標 (UV ではない)。UV を渡すと解像度によってパターンが変わる。
 */
fn dither(px: vec2f) -> f32 {
  let u = vec2u(vec2i(px));
  // WGSL は '*' と '^' の混在に明示の括弧を要求する (C と違い暗黙の優先順位を許さない)。
  var h = (u.x * 0x9e3779b9u) ^ (u.y * 0x85ebca6bu);
  h ^= h >> 15u; h *= 0x2c1b3c6du;
  h ^= h >> 12u;
  return (f32(h & 0xffffu) / 65536.0 - 0.5) / 255.0;
}
`;
