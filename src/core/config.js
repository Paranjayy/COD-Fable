/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  low: {
    renderScale: 0.72,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 60,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
  },
  medium: {
    renderScale: 0.85,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
  },
  high: {
    renderScale: 1.0,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
  },
  ultra: {
    renderScale: 1.0,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
  },
};

export const DEFAULTS = {
  quality: 'ultra',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
  /**
   * レンダリングバックエンド。
   *
   *   undefined  自動 — WebGPU が使えれば WebGPU、駄目なら WebGL2 に落ちる
   *   'webgpu'   強制。使えなければ **例外を投げる**
   *   'webgl2'   強制。WebGPU を試さない
   *
   * 「強制すると例外」なのが重要な点。pixel gate (tools/imagediff.mjs) は
   * バックエンドが違えば当然一致しないので、比較する 2 本のキャプチャが同じ
   * バックエンドで撮られたことを保証できないと「最適化で絵が変わった」と誤診する。
   * 自動フォールバックが黙って起きる状態でベースラインを撮るのが最も危険なため、
   * ハーネスは必ず `?backend=webgpu` を明示して撮る (tools/capture.mjs 参照)。
   */
  backend: undefined,
};

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}
