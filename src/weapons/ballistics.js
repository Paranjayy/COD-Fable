import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * Projectile ballistics — Babylon 移植版 (ロジックは Three 版と同一)。
 *
 * Rounds are simulated, not hitscanned: each shot is a body with a muzzle
 * velocity, gravity and a drag term, stepped at the physics rate. Terminal
 * effects は接触の瞬間に `physics.fireBullet()` へ渡す — 貫通・多層ヒットは
 * physics が一元管理する (自前で当たり判定を持たないこと)。
 */

const GRAVITY = -9.81;
const MAX_LIVE = 96;

class Projectile {
  constructor() {
    this.alive = false;
    this.pos = new Vector3();
    this.prev = new Vector3();
    this.vel = new Vector3();
    this.dir = new Vector3();
    this.damage = 30;
    this.penetration = 1;
    this.dragK = 0.3;
    this.travelled = 0;
    this.maxRange = 400;
    this.age = 0;
    this.dropoff = 0.5;
    this.weapon = null;
    this.mask = undefined;
  }
}

export class ProjectileSim {
  constructor(ctx) {
    this.ctx = ctx;
    this.pool = [];
    for (let i = 0; i < MAX_LIVE; i++) this.pool.push(new Projectile());
    this.live = [];
    this._seg = new Vector3();
    this._hitDir = new Vector3();
    this._tracerFrom = new Vector3();
    this._tracerTo = new Vector3();
    this._tracerPayload = { from: this._tracerFrom, to: this._tracerTo, speed: 800, weapon: null };
    this.stats = { fired: 0, impacts: 0, live: 0 };
  }

  get physics() {
    if (!this._physics) this._physics = this.ctx.peek('physics');
    return this._physics;
  }

  /**
   * @param {object} o origin, dir (unit), speed, damage, penetration, dragK,
   *                   maxRange, dropoff, weapon, tracer
   */
  spawn(o) {
    let p = null;
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].alive) {
        p = this.pool[i];
        break;
      }
    }
    if (!p) {
      // Oldest round yields its slot rather than dropping the shot.
      p = this.live[0];
      if (!p) return null;
      this._retire(p);
      this.live.shift();
    }
    p.alive = true;
    p.pos.copyFrom(o.origin);
    p.prev.copyFrom(o.origin);
    p.dir.copyFrom(o.dir).normalize();
    p.vel.copyFrom(p.dir).scaleInPlace(o.speed ?? 800);
    p.damage = o.damage ?? 30;
    p.penetration = o.penetration ?? 1;
    p.dragK = o.dragK ?? 0.3;
    p.dropoff = o.dropoff ?? 0.5;
    p.maxRange = o.maxRange ?? 400;
    p.travelled = 0;
    p.age = 0;
    p.weapon = o.weapon ?? null;
    p.mask = o.mask;
    this.live.push(p);
    this.stats.fired++;

    if (o.tracer) this._emitTracer(p, o.speed ?? 800);
    return p;
  }

  /** One tracer per burst of rounds: muzzle to wherever the round will land. */
  _emitTracer(p, speed) {
    const phys = this.physics;
    this._tracerFrom.copyFrom(p.pos);
    let dist = Math.min(p.maxRange, 260);
    if (phys) {
      const hit = phys.raycast(p.pos, p.dir, dist, phys.MASK?.BULLET);
      if (hit?.hit) dist = hit.distance;
    }
    this._tracerTo.copyFrom(p.pos);
    p.dir.scaleAndAddToRef(dist, this._tracerTo);
    this._tracerPayload.speed = speed;
    this._tracerPayload.weapon = p.weapon;
    this.ctx.events.emit('bullet:tracer', this._tracerPayload);
  }

  fixedUpdate(h) {
    const phys = this.physics;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.prev.copyFrom(p.pos);
      // gravity + a linear drag term (good enough over game distances)
      p.vel.y += GRAVITY * h;
      const decay = Math.max(0, 1 - p.dragK * h);
      p.vel.scaleInPlace(decay);
      p.vel.scaleAndAddToRef(h, p.pos);
      p.age += h;

      this._seg.copyFrom(p.pos).subtractInPlace(p.prev);
      const segLen = this._seg.length();
      p.travelled += segLen;

      if (segLen > 1e-6 && phys) {
        this._hitDir.copyFrom(this._seg).scaleInPlace(1 / segLen);
        const hit = phys.raycast(p.prev, this._hitDir, segLen, phys.MASK?.BULLET);
        if (hit?.hit) {
          // Contact: hand the round to the penetration solver, which emits
          // `bullet:impact` for every entry and exit face it goes through.
          const range01 = Math.min(1, p.travelled / p.maxRange);
          const falloff = 1 - (1 - p.dropoff) * range01 * range01;
          phys.fireBullet({
            origin: p.prev,
            dir: this._hitDir,
            maxDist: Math.min(24, Math.max(1.5, p.maxRange - p.travelled + segLen)),
            damage: p.damage * falloff,
            penetration: p.penetration,
            dropoff: 1,
            mask: p.mask,
          });
          this.stats.impacts++;
          this._retire(p);
          this.live.splice(i, 1);
          continue;
        }
      }

      if (p.travelled > p.maxRange || p.age > 5 || p.pos.y < -80) {
        this._retire(p);
        this.live.splice(i, 1);
      }
    }
    this.stats.live = this.live.length;
  }

  _retire(p) {
    p.alive = false;
    p.weapon = null;
  }

  clear() {
    for (const p of this.live) this._retire(p);
    this.live.length = 0;
  }
}
