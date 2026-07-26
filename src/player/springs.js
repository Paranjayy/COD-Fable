/**
 * Scalar maths + spring integrators used by the player controller.
 *
 * Everything here is allocation-free after construction and framerate
 * independent: the springs sub-step internally so a 8 ms physics tick and a
 * 33 ms hitch produce the same visible motion.
 */

import { MAX_FRAME_DT } from '../core/config.js';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/**
 * Both clamps are the NaN barrier every caller assumes them to be: a bare
 * comparison chain lets NaN through (both tests are false for it), and one NaN
 * reaching a spring latches there forever and takes the camera with it.
 */
export function clamp(v, a, b) {
  if (Number.isNaN(v)) return a;
  return v < a ? a : v > b ? b : v;
}

export function clamp01(v) {
  if (Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

/** C2-continuous ease — used for rooted mantle curves where velocity must not pop. */
export function smootherstep(t) {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function easeOutCubic(t) {
  t = clamp01(t);
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeInOutSine(t) {
  return 0.5 - 0.5 * Math.cos(clamp01(t) * Math.PI);
}

/**
 * Exponential approach with a real time constant. `tau` is the 63 % time, so
 * "reach it in about a tenth of a second" is tau = 0.1 / 2.3.
 */
export function approach(current, target, tau, dt) {
  if (tau <= 1e-6) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Constant-rate move, for things that must not have an asymptotic tail. */
export function moveToward(current, target, rate, dt) {
  const d = target - current;
  const step = rate * dt;
  if (d > step) return current + step;
  if (d < -step) return current - step;
  return target;
}

/** Shortest signed angular difference, radians. */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

/** Deterministic value noise in 1D — camera shake without touching any RNG. */
export function hashNoise(x, seed = 0) {
  const xi = Math.floor(x);
  const f = x - xi;
  const h = (i) => {
    let n = (i | 0) ^ (seed * 374761393);
    n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
    n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
    n ^= n >>> 15;
    return ((n >>> 0) / 4294967296) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(xi) * (1 - u) + h(xi + 1) * u;
}

const MAX_SUB_DT = 1 / 360;
/**
 * Enough sub-steps to integrate the engine's whole frame-dt clamp (36 of them
 * at 1/360), plus one so float residue in the last slice is never left behind.
 * A lower cap silently drops part of a long frame and the spring freezes
 * mid-travel, which pops the moment the framerate recovers.
 */
const MAX_SUB_STEPS = Math.ceil(MAX_FRAME_DT / MAX_SUB_DT) + 1;

/**
 * Damped harmonic oscillator, driven by frequency (Hz) and damping ratio.
 *   zeta < 1  under-damped, overshoots — good for punchy recoil
 *   zeta = 1  critically damped, fastest non-overshooting — good for FOV/ADS
 * `impulse()` injects velocity (the physical way to kick a spring), `set()`
 * displaces it instantly.
 */
export class Spring {
  constructor(freq = 8, damping = 0.7, value = 0) {
    this.freq = freq;
    this.damping = damping;
    this.value = value;
    this.velocity = 0;
    this.target = 0;
  }

  reset(value = 0) {
    this.value = value;
    this.velocity = 0;
    return this;
  }

  impulse(v) {
    this.velocity += v;
    return this;
  }

  set(v) {
    this.value = v;
    return this;
  }

  step(dt) {
    if (dt <= 0) return this.value;
    const w = TAU * this.freq;
    const k = w * w;
    const c = 2 * this.damping * w;
    // Sub-step so a stiff spring stays stable through a dropped frame.
    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-7 && guard++ < MAX_SUB_STEPS) {
      const h = remaining > MAX_SUB_DT ? MAX_SUB_DT : remaining;
      remaining -= h;
      const a = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    // Kill denormal ringing so idle frames are bit-stable for capture.
    if (Math.abs(this.value - this.target) < 1e-7 && Math.abs(this.velocity) < 1e-6) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }
}

/**
 * Two-layer response: a fast under-damped spring plus a slow exponential
 * residual. Real weapon/camera recoil rises instantly, snaps most of the way
 * back, then settles — a single spring can only do two of those three.
 */
export class RecoilAxis {
  constructor(freq = 9.5, damping = 0.52, residualTau = 0.3, residualShare = 0.34) {
    this.spring = new Spring(freq, damping, 0);
    this.residual = 0;
    this.residualTau = residualTau;
    this.residualShare = residualShare;
    this.value = 0;
  }

  reset() {
    this.spring.reset(0);
    this.residual = 0;
    this.value = 0;
  }

  /** `amount` is an angle in radians (or metres for a positional axis). */
  kick(amount) {
    // A displacement kick reads snappier than a velocity kick for recoil.
    this.spring.value += amount * (1 - this.residualShare);
    this.residual += amount * this.residualShare;
  }

  step(dt) {
    this.spring.step(dt);
    this.residual = approach(this.residual, 0, this.residualTau, dt);
    this.value = this.spring.value + this.residual;
    return this.value;
  }
}
