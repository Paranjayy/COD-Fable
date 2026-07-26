/**
 * The camouflage cloth bake, as a fragment shader.
 *
 * WHY: baking the three camo patterns on the CPU cost 688 ms of a 1168 ms
 * character-texture bake — 59% of it, and ~11% of the whole boot — for three
 * 512px tiles. The engine already owns a GPU texture forge (materials/
 * generator.js); this is the same surface expressed as `owSurface()` so the
 * forge can evaluate it in four full-screen draws instead of 786k JS iterations.
 *
 * WHY IT LOOKS IDENTICAL: `TileNoise` is table-driven — a 4096-entry value table
 * and a 4096-entry permutation, both filled from the deterministic Rng. Those
 * two tables are uploaded as 64x64 float textures and the same integer lattice
 * arithmetic is repeated here, so the noise is not "equivalent", it is the same
 * numbers. Every constant below is transcribed from textures.js; where the two
 * disagree textures.js is the source of truth.
 *
 * DELIBERATELY NOT PORTED: `measureCamo`, the 96x96 pre-pass whose mean feeds
 * the budget remap. It is 9216 samples against 262144 (~3.5% of a bake), and it
 * has to produce a single scalar the shader needs *before* the first texel is
 * written. It stays on the CPU and arrives as `uSrcMean`, which keeps the
 * calibration bit-identical rather than approximating it with a GPU reduction.
 *
 * GLSL ES 1.00 ONLY: three compiles ShaderMaterial without `#version 300 es`
 * unless asked, so there are no bitwise operators and no `texelFetch` here. The
 * lattice hash is done in floats — every value involved is a small integer, far
 * inside the 2^24 where floats are exact, so this is not an approximation.
 */

/**
 * How the shader packs relief into the 0..1 height target. Kept next to the
 * shader because `camoSobelStrength()` below is only correct paired with it.
 */
export const CAMO_HEIGHT_SCALE = 0.25;

/**
 * The forge's Sobel is not the CPU one, so the slope has to be matched rather
 * than guessed. Derivation, for a height field H and the same 3x3 kernel:
 *
 *   CPU:  nx = -dx_cpu * (normalScale * 0.17)          [bake() in textures.js]
 *   GPU:  nx = -(dx_gpu * 0.125 * size) * uStrength    [SOBEL in generator.js]
 *   and   dx_gpu = CAMO_HEIGHT_SCALE * dx_cpu          [this shader packs H]
 *
 * Equating the two gives the strength the forge must be handed. Passing it as
 * `relief` with `worldSize: 1` is just how the forge spells `uStrength`.
 */
export function camoSobelStrength(size, normalScale = 0.9) {
  return (normalScale * 0.17) / (CAMO_HEIGHT_SCALE * 0.125 * size);
}

export const CAMO_GLSL = /* glsl */ `
uniform sampler2D uAiTab;    // 64x64 R32F — TileNoise.tab, 4096 floats
uniform sampler2D uAiPerm;   // 64x64 R32F — TileNoise.perm, 4096 ints as floats
uniform vec3  uAiPale;
uniform vec3  uAiBase;
uniform vec3  uAiMid;
uniform vec3  uAiDark;
uniform vec3  uAiOlive;
uniform vec2  uAiCamo;       // x = macro period, y = warp
uniform vec4  uAiBudget;     // mean, min, max, contrast
uniform vec2  uAiCal;        // x = saturation, y = measured source mean

/** One entry of a 4096-long table stored as 64x64, sampled dead-centre. */
float owAiTable(sampler2D t, float idx) {
  float y = floor(idx / 64.0);
  float x = idx - y * 64.0;
  return texture2D(t, (vec2(x, y) + 0.5) / 64.0).r;
}

/**
 * TileNoise._h. GLSL mod() is x - y*floor(x/y), which is already the
 * non-negative result the JS writes as ((i % p) + p) % p.
 */
float owAiH(float ix, float iy, float period) {
  float p = floor(period);
  float x = mod(ix, p);
  float y = mod(iy, p);
  float pi = mod(x * 73.0 + y * 151.0, 4096.0);
  float pv = owAiTable(uAiPerm, pi);
  float ti = mod(pv + x * 31.0 + y * 17.0, 4096.0);
  return owAiTable(uAiTab, ti);
}

float owAiN2(vec2 uv, float period) {
  float x = uv.x * period, y = uv.y * period;
  float ix = floor(x), iy = floor(y);
  float fx = x - ix, fy = y - iy;
  float sx = fx * fx * (3.0 - 2.0 * fx);
  float sy = fy * fy * (3.0 - 2.0 * fy);
  float a = owAiH(ix, iy, period);
  float b = owAiH(ix + 1.0, iy, period);
  float c = owAiH(ix, iy + 1.0, period);
  float d = owAiH(ix + 1.0, iy + 1.0, period);
  return (a + (b - a) * sx) * (1.0 - sy) + (c + (d - c) * sx) * sy;
}

float owAiFbm(vec2 uv, float period, int oct, float gain) {
  float a = 1.0, s = 0.0, norm = 0.0, p = period;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * owAiN2(uv, p);
    norm += a;
    a *= gain;
    p *= 2.0;
  }
  return s / norm;
}

float owAiRidge(vec2 uv, float period, int oct) {
  float a = 1.0, s = 0.0, norm = 0.0, p = period;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * (1.0 - abs(owAiN2(uv, p) * 2.0 - 1.0));
    norm += a;
    a *= 0.55;
    p *= 2.0;
  }
  return s / norm;
}

/** textures.js smooth(): a clamped smoothstep, and it accepts e0 > e1. */
float owAiSm(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float owAiCell(float x) { return abs(mod(x, 1.0) - 0.5); }
float owAiRidgeLine(float d, float w) { return owAiSm(w, 0.0, d); }

/** garmentRelief() — felled seams, stitch beads, pocket creases, wrinkles. */
float owAiRelief(vec2 uv) {
  float u = uv.x, v = uv.y;
  float drift = (owAiFbm(vec2(u, v), 3.0, 2, 0.5) - 0.5) * 0.22;
  float sa = owAiCell(v * 4.0 + drift);
  float h = -owAiRidgeLine(sa, 0.013) * 0.62
          + (owAiRidgeLine(sa, 0.030) - owAiRidgeLine(sa, 0.016)) * 0.34;

  float drift2 = (owAiFbm(vec2(v + 4.1, u), 3.0, 2, 0.5) - 0.5) * 0.26;
  float sb = owAiCell(u * 2.5 + drift2);
  h += -owAiRidgeLine(sb, 0.009) * 0.46
     + (owAiRidgeLine(sb, 0.022) - owAiRidgeLine(sb, 0.011)) * 0.22;

  float onSeam = max(owAiRidgeLine(sa, 0.020), owAiRidgeLine(sb, 0.014));
  h += onSeam * (0.5 + 0.5 * sin((u + v) * 520.0)) * 0.26;

  float gate = owAiSm(0.55, 0.72, owAiFbm(vec2(u + 1.7, v + 2.3), 3.0, 2, 0.5));
  float pu = owAiCell(u * 3.5 + 0.31);
  float pvv = owAiCell(v * 3.0 + 0.17);
  h -= gate * max(owAiRidgeLine(pu, 0.012), owAiRidgeLine(pvv, 0.014)) * 0.55;

  h += (owAiFbm(vec2(u, v), 10.0, 3, 0.5) - 0.5) * 0.95;
  h += (owAiFbm(vec2(u + 5.3, v + 1.9), 26.0, 2, 0.5) - 0.5) * 0.34;

  float crease = owAiRidge(vec2(u + 3.1, v - 2.2), 52.0, 2);
  h += (crease - 0.55) * 0.46;
  h += (owAiRidge(vec2(v * 0.7 + 8.4, u * 0.7 + 1.1), 74.0, 2) - 0.55) * 0.22;
  return h;
}

const vec3 OW_LUM = vec3(0.2126, 0.7152, 0.0722);

/** applyBudget(): recentre the mean, stretch contrast, clamp, resaturate. */
vec3 owAiBudget(vec3 c) {
  float l = dot(c, OW_LUM);
  if (l < 1e-6) return c;
  float t = clamp(uAiBudget.x + (l - uAiCal.y) * uAiBudget.w, uAiBudget.y, uAiBudget.z);
  float k = t / l;
  vec3 s = vec3(l) + (c - vec3(l)) * uAiCal.x;
  float l2 = max(1e-6, dot(s, OW_LUM));
  return s * ((l * k) / l2);
}

void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao) {
  float u = uv.x, v = uv.y;
  float M = uAiCamo.x;
  float warp = uAiCamo.y;

  // domain warp -> elongated organic blotches instead of round blobs
  float wx = owAiFbm(vec2(u + 0.31, v + 0.17), M * 2.0, 2, 0.5) - 0.5;
  float wy = owAiFbm(vec2(u + 0.73, v + 0.59), M * 2.0, 2, 0.5) - 0.5;
  vec2 m = vec2(u + wx * warp, v + wy * warp);

  float a = owAiFbm(vec2(m.x + 0.11, m.y), M, 2, 0.40);
  float b = owAiFbm(vec2(m.x, m.y + 0.37), M, 2, 0.40);
  float c = owAiFbm(vec2(m.x + 0.61, m.y + 0.23), M + 1.0, 2, 0.44);
  float d = owAiFbm(vec2(m.x + 0.29, m.y + 0.83), M + 2.0, 2, 0.44);

  // narrow transition bands — printed camo has hard family edges
  vec3 col = uAiBase;
  col = mix(col, uAiPale,  owAiSm(0.535, 0.585, a));
  col = mix(col, uAiOlive, owAiSm(0.555, 0.605, b) * 0.9);
  col = mix(col, uAiMid,   owAiSm(0.515, 0.565, c));
  col = mix(col, uAiDark,  owAiSm(0.605, 0.655, d));

  float f1 = owAiSm(0.40, 0.60, owAiFbm(vec2(u + 3.7, v + 1.3), 24.0, 2, 0.35));
  float f2 = owAiSm(0.52, 0.70, owAiN2(vec2(u + 7.1, v + 2.9), 48.0));
  float fine = 0.88 + 0.26 * f1 - 0.12 * f2;

  float relief = owAiRelief(vec2(u, v));
  float bleach = 1.0 + 0.05 * owAiSm(-0.2, 0.9, relief);

  vec3 raw = vec3(col.r * fine * bleach,
                  col.g * fine * bleach,
                  col.b * fine * bleach * 0.99);
  alb = owAiBudget(raw);

  // The CPU bake Sobel'd a Float32 buffer holding the RAW relief, which is not
  // confined to 0..1; the forge's height target is, so the relief is packed as
  // relief * OW_AI_HS + 0.5. HS = 0.25 keeps +/-2 of relief inside the target
  // instead of clipping the peaks flat, and CAMO_HEIGHT_SCALE in the JS side
  // undoes exactly this factor when it computes the Sobel strength.
  h = clamp(relief * 0.25 + 0.5, 0.0, 1.0);
  rough = 0.905 - 0.045 * owAiSm(-0.6, 0.8, relief)
        + 0.035 * (owAiFbm(vec2(u, v), 9.0, 3, 0.5) - 0.5);
  metal = 0.0;
  ao = 0.82 + 0.18 * owAiSm(-0.7, 0.7, relief);
}
`;
