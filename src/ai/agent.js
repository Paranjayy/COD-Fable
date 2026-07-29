/**
 * AI — one enemy: body, senses, brain, gun.
 *
 * PERCEPTION is deliberately imperfect. A target has to be inside a 100 degree
 * cone, in line of sight through the physics world, and then *stay* there for a
 * reaction delay that scales with angle off-centre and distance before the
 * agent acknowledges it. Gunshots and footsteps arrive as events and only give
 * a direction, which becomes a "last known position" that decays — so enemies
 * search where you were, not where you are.
 *
 * BEHAVIOUR is a small state machine:
 *   idle / patrol -> alert -> combat -> suppressed -> flank -> retreat -> dead
 * Combat runs a peek-and-shoot loop from a scored cover point, with the squad
 * handing out permission to peek so they never all lean out at once, plus
 * suppressing fire, grenades and repositioning when the player stops moving.
 *
 * DAMAGE is per-bone: capsule colliders for head, chest, pelvis, arms and legs
 * follow the animated skeleton every frame (hitbox.js の ANIMATED ボディ), so a
 * headshot is a headshot because of where the round landed, not because of a
 * random roll. Death plays a deterministic procedural collapse (deathfall.js —
 * ラグドールを持たない理由はそちらのコメント参照).
 *
 * ## Babylon 移植で変わった構図 (Three 版との差分)
 *
 *  - ビジュアル: THREE.SkinnedMesh + Group → Babylon Mesh(clone) + TransformNode。
 *    アニメーションは CPU 側 math3.Bone 階層で解き、毎フレーム
 *    `syncSkeleton()` で Babylon の Skeleton に写す (mesh.js 参照)。
 *  - 移動: Babylon 版 Character.move は「速度」を fixedUpdate から渡す方式
 *    (Three 版は「変位」を update から)。update() は毎フレーム希望速度を作り、
 *    AiSystem.fixedUpdate → agent.fixedUpdate(h) が積分する。
 *  - CC の position は**カプセル中心** (characterController.js の footOffset
 *    参照)。this.position は Three 版と同じ「足元」を維持し、境界で変換する。
 *    ここを混ぜると全員が 0.9 m 浮く/沈む。
 *  - CC の shape フィルタを membership=CLIP / collideWith=MASK.CHARACTER に
 *    設定する。**自分のヒットボックス (ACTOR) を CC の掃引から外すため**で、
 *    hitbox.js のフィルタ設計とセット。外すと一歩も歩けなくなる。
 */

import * as THREE from './math3.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Quaternion as BQuaternion } from '@babylonjs/core/Maths/math.vector.js';

import { RIG } from './rig.js';
import { Animator } from './animator.js';
import { createBabylonSkeleton, syncSkeleton, applyInflatedBounds } from './mesh.js';
import { HitboxSet } from './hitbox.js';
import { DeathFall } from './deathfall.js';
import { ray, rayAny } from './physray.js';

const STATE = {
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',
  COMBAT: 'combat',
  SUPPRESSED: 'suppressed',
  FLANK: 'flank',
  RETREAT: 'retreat',
  DEAD: 'dead',
};

export { STATE };

/** [part, boneA, boneB, radius, damageScale] */
const HITBOXES = [
  ['head', 'Head', 'HeadTop', 0.098, 4.0],
  ['torso', 'Spine1', 'Neck', 0.185, 1.0],
  ['torso', 'Hips', 'Spine1', 0.175, 0.9],
  ['arm', 'UpperArmR', 'HandR', 0.072, 0.65],
  ['arm', 'UpperArmL', 'HandL', 0.072, 0.65],
  ['leg', 'UpLegR', 'FootR', 0.105, 0.7],
  ['leg', 'UpLegL', 'FootL', 0.105, 0.7],
];

const UP = new THREE.Vector3(0, 1, 0);

let _nextId = 1;

export class Agent {
  constructor(ai, opts = {}) {
    this.ai = ai;
    this.ctx = ai.ctx;
    this.id = _nextId++;
    this.rng = ai.rng.fork();
    this.variantName = opts.variant ?? 'vanguard';
    const def = ai.variant(this.variantName);
    this.def = def;
    this.scale = def.variant.scale ?? 1;

    /* ---------------- body ---------------- */
    // CPU 側: アニメーション/IK が解く姿勢木。actor がワールド変換 (位置+yaw+scale)。
    const { bones, root } = RIG.createSkeleton();
    this.bones = bones;
    this.actor = new THREE.Object3D();
    this.actor.name = `enemy${this.id}`;
    this.actor.add(root);
    this.actor.scale.setScalar(this.scale);

    // Babylon 側: テンプレートの clone (ジオメトリ共有) + アクター専用スケルトン。
    const scene = this.ctx.scene;
    this.node = new TransformNode(`enemy${this.id}`, scene);
    this.node.parent = ai.root;
    this.node.rotationQuaternion = BQuaternion.Identity();
    this.node.scaling.setAll(this.scale);
    this.mesh = def.template.clone(`enemy${this.id}_mesh`, this.node);
    this.mesh.setEnabled(true);
    this.mesh.metadata = { agent: this, owNoShadow: false };
    applyInflatedBounds(this.mesh, def.geometry.boundingBox);
    const sk = createBabylonSkeleton(scene, RIG, `sk_enemy${this.id}`);
    this.skeleton = sk.skeleton;
    this.bBones = sk.bBones;
    this.mesh.skeleton = this.skeleton;
    // 影キャスタ登録。画面外 LOD (AiSystem._updateRelevance) が add/remove を
    // 切り替えるので、現在の登録状態をここで追跡する。
    this._render = this.ctx.peek('render');
    this._render?.addShadowCaster(this.mesh, false);
    this._castingShadow = true;

    this.mass = 82 * this.scale;

    this.position = new THREE.Vector3().copy(opts.position ?? new THREE.Vector3());
    this.yaw = opts.yaw ?? 0;
    this.targetYaw = this.yaw;
    this.actor.position.copy(this.position);
    this.actor.quaternion.setFromAxisAngle(UP, this.yaw);
    // ボーンのワールド行列はアクターの行列から導かれるので、何かがそれを読む前
    // (最初の animator パスや同フレームの死亡処理) に最新化しておく。
    this.actor.updateMatrix();
    this.actor.updateMatrixWorld();
    this._syncNode();

    this.animator = new Animator(RIG, bones, {
      weapon: def.weapon,
      rng: this.rng.fork(),
      scale: this.scale,
      probe: (x, z, fromY, out) => this.ai.probeGround(x, z, fromY, out),
    });

    /* ---------------- physics ---------------- */
    const phys = this.ctx.peek('physics');
    this.phys = phys;
    this.height = 1.78 * this.scale;
    this.radius = 0.34 * this.scale;
    this.controller = phys
      ? phys.createCharacter({
        radius: this.radius,
        height: this.height,
        // CC はカプセル中心基準 (冒頭コメント)。this.position は足元。
        position: { x: this.position.x, y: this.position.y + this.height * 0.5, z: this.position.z },
        stepHeight: 0.42,
        slopeLimit: 48,
      })
      : null;
    if (this.controller) {
      // 自分のヒットボックス (ACTOR) と衝突しないための CC 側フィルタ。
      // hitbox.js 冒頭の設計コメントとセットで読むこと。
      const shape = this.controller.ctrl.shape;
      shape.filterMembershipMask = phys.LAYER.CLIP;
      shape.filterCollideMask = phys.MASK.CHARACTER;
    }
    this.velocity = new THREE.Vector3();
    this.grounded = true;
    /** update() が作り fixedUpdate() が消費する希望水平速度。 */
    this._wishVx = 0;
    this._wishVz = 0;

    this.hitboxes = phys ? new HitboxSet(phys, scene, this, HITBOXES, RIG, this.scale) : null;

    /* ---------------- stats ---------------- */
    this.health = 100;
    this.maxHealth = 100;
    this.alive = true;
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.squad = opts.squad ?? null;
    this.team = opts.team ?? 1;

    /* ---------------- perception ---------------- */
    this.eyeHeight = RIG.eyeHeight * this.scale;
    this.viewRange = 58;
    this.viewCos = Math.cos((100 * Math.PI) / 180 / 2);
    this.awareness = 0; // 0..1 build-up before the target is acknowledged
    this.hasTarget = false;
    this.targetVisible = false;
    this.target = null;
    this.lastKnown = new THREE.Vector3();
    this.lastKnownAge = Infinity;
    this.searchPoint = new THREE.Vector3();
    this.suppression = 0;
    this.reactionTimer = 0;
    this.alertness = 0;

    /* ---------------- combat ---------------- */
    this.weaponRange = 60;
    this.fireRate = this.variantName === 'irregular' ? 8.2 : 10.5;
    this.burstLeft = 0;
    this.fireCooldown = 0;
    this.burstCooldown = this.rng.range(0.4, 1.4);
    this.magSize = 30;
    this.ammo = this.magSize;
    this.spread = 0.032;
    this.weaponDamage = 17;
    this.aimTarget = new THREE.Vector3();
    this.aimActual = new THREE.Vector3();
    this.aimWeight = 0;
    this.wantFire = false;
    this.peekSide = 0;
    this.peeking = false;
    this.peekTimer = this.rng.range(0.5, 2.5);
    this.grenadeCooldown = this.rng.range(9, 22);
    this.hasGrenade = true;

    /* ---------------- navigation ---------------- */
    this.path = [];
    this.pathLen = 0;
    this.pathIndex = 0;
    this.repathTimer = 0;
    this.moveTarget = new THREE.Vector3().copy(this.position);
    this.hasMoveTarget = false;
    this.desiredSpeed = 0;
    this.speed = 0;
    this.crouch = false;
    this.cover = null;
    this.coverPos = new THREE.Vector3();
    this.patrolPoints = opts.patrol ?? null;
    this.patrolIndex = 0;
    this.stuckTimer = 0;
    this.vaultCooldown = 0;
    /** a path request the frame budget pushed to the next frame */
    this.pathPending = false;
    this._pendingDest = new THREE.Vector3();

    /* ---------------- death ---------------- */
    this.deathFall = new DeathFall(RIG, bones);
    this._deathOut = { rootAngle: 0, rootAxis: null, rootTwist: 0, rootY: 0 };
    this._deathQ = new THREE.Quaternion();
    this._deathQ2 = new THREE.Quaternion();

    /* ---------------- LOD ---------------- */
    /** set by AiSystem._updateRelevance: nothing this actor does reaches a pixel */
    this.lodIrrelevant = false;
    this._animSkip = 0;
    this._animAccum = 0;

    /* ---------------- scratch ---------------- */
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._steer = new THREE.Vector3();
    this._boneA = new THREE.Vector3();
    this._boneB = new THREE.Vector3();
    this._muzzleDir = new THREE.Vector3();

    this.clip = 'idle';
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  get eye() {
    return this._eye.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  update(dt, ctx) {
    if (!this.alive) return;
    this.stateTime += dt;
    this.suppression = Math.max(0, this.suppression - dt * 0.55);
    this.fireCooldown -= dt;
    this.burstCooldown -= dt;
    this.grenadeCooldown -= dt;
    this.peekTimer -= dt;
    this.repathTimer -= dt;
    this.vaultCooldown -= dt;
    if (this.lastKnownAge < 1e6) this.lastKnownAge += dt;

    // a path the frame budget deferred: ask again before anything else does
    if (this.pathPending) this._goTo(this._pendingDest);

    this._sense(dt);
    this._think(dt);
    this._move(dt);
    this._shoot(dt);
    this._drive(dt);
  }

  /**
   * 物理積分 (120 Hz 固定)。AiSystem.fixedUpdate から呼ばれる。
   * Babylon 版 Character.move は「速度」を渡す約束 (physics/index.js)。
   */
  fixedUpdate(h) {
    const c = this.controller;
    if (!c || !this.alive) return;
    this.velocity.y += this.phys.gravity.y * h;
    c.setHeight?.(this.crouch ? 1.16 * this.scale : this.height);
    c.move(this._wishVx, this.velocity.y, this._wishVz);
    // CC のカプセル中心 → 足元へ変換して保持 (冒頭コメント)
    this.position.set(
      c.position.x,
      c.position.y - c.height * 0.5,
      c.position.z
    );
    this.grounded = c.grounded;
    if (c.grounded && this.velocity.y < 0) this.velocity.y = 0;
  }

  /* ================================================================== */
  /* perception                                                         */
  /* ================================================================== */

  _sense(dt) {
    const player = this.ai.playerPosition(this._v3);
    if (!player) return;
    const eye = this.eye;
    const to = this._dir.copy(player).sub(eye);
    const dist = to.length();
    let visible = false;
    if (dist < this.viewRange) {
      to.multiplyScalar(1 / dist);
      const fwd = this._v2.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const dot = fwd.x * to.x + fwd.z * to.z;
      // peripheral vision widens once alerted
      const cone = this.hasTarget ? -0.2 : this.viewCos - this.alertness * 0.25;
      if (dot > cone || dist < 4.5) {
        visible = this.phys ? this.phys.lineOfSight(eye, player, this.phys.MASK.SIGHT) : true;
      }
    }
    this.targetVisible = visible;

    if (visible) {
      // reaction: fast head-on and close, slow at the edge of vision
      const rate = 1 / Math.max(0.12, 0.16 + dist * 0.0075 + (1 - this.alertness) * 0.28);
      this.awareness = Math.min(1, this.awareness + dt * rate);
      this.lastKnown.copy(player);
      this.lastKnownAge = 0;
      this.alertness = 1;
      if (this.awareness >= 1) {
        this.hasTarget = true;
        this.target = player;
      }
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.35);
      if (this.hasTarget && this.lastKnownAge > 6.5) this.hasTarget = false;
    }
  }

  /** A gunshot or footstep heard from `pos` with a given loudness (metres). */
  hear(pos, loudness) {
    if (!this.alive) return;
    const d = this.position.distanceTo(pos);
    if (d > loudness) return;
    const strength = 1 - d / loudness;
    this.alertness = Math.max(this.alertness, Math.min(1, 0.35 + strength));
    if (this.lastKnownAge > 1.2 || strength > 0.6) {
      this.lastKnown.copy(pos);
      this.lastKnownAge = Math.min(this.lastKnownAge, 0.35);
    }
    // hearing alone never grants a target; it turns the head and the body
    this.awareness = Math.min(0.85, this.awareness + strength * 0.5);
    if (this.state === STATE.IDLE || this.state === STATE.PATROL) this._setState(STATE.ALERT);
  }

  /** Rounds cracking past raise suppression, which drives the flinch + duck. */
  suppress(amount) {
    if (!this.alive) return;
    this.suppression = Math.min(1.6, this.suppression + amount);
    this.alertness = 1;
  }

  /* ================================================================== */
  /* behaviour                                                          */
  /* ================================================================== */

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
    if (s !== STATE.COMBAT && s !== STATE.SUPPRESSED) this.peeking = false;
  }

  _think(dt) {
    const sq = this.squad;
    switch (this.state) {
      case STATE.IDLE:
        this.desiredSpeed = 0;
        this.crouch = false;
        if (this.hasTarget) this._enterCombat();
        else if (this.patrolPoints && this.stateTime > 2.5) this._setState(STATE.PATROL);
        break;

      case STATE.PATROL: {
        this.crouch = false;
        this.desiredSpeed = 1.35;
        if (this.hasTarget) {
          this._enterCombat();
          break;
        }
        // a route point whose path is still queued is not a route point reached:
        // taking the next one here would walk the patrol index forward for free
        if (this.pathPending) break;
        if (!this.hasMoveTarget || this.position.distanceTo(this.moveTarget) < 1.1) {
          const p = this.patrolPoints?.[this.patrolIndex % this.patrolPoints.length];
          if (p) {
            this.patrolIndex++;
            this._goTo(p);
          } else this._setState(STATE.IDLE);
        }
        break;
      }

      case STATE.ALERT: {
        this.crouch = false;
        this.desiredSpeed = 1.5;
        if (this.hasTarget) {
          this._enterCombat();
          break;
        }
        // move to the last known position, then look around
        if (this.lastKnownAge < 8 && !this.hasMoveTarget) this._goTo(this.lastKnown);
        if (this.stateTime > 12) this._setState(this.patrolPoints ? STATE.PATROL : STATE.IDLE);
        break;
      }

      case STATE.COMBAT:
        this._combat(dt);
        break;

      case STATE.SUPPRESSED:
        this.crouch = true;
        this.desiredSpeed = 0;
        this.wantFire = false;
        this.peeking = false;
        if (this.suppression < 0.45) this._setState(STATE.COMBAT);
        break;

      case STATE.FLANK: {
        this.crouch = false;
        this.desiredSpeed = 4.4;
        this.wantFire = false;
        if (!this.hasMoveTarget || this.position.distanceTo(this.moveTarget) < 1.2 || this.stateTime > 7) {
          this._setState(STATE.COMBAT);
          this.cover = null;
        }
        if (this.suppression > 1.0) this._setState(STATE.COMBAT);
        break;
      }

      case STATE.RETREAT: {
        this.crouch = false;
        this.desiredSpeed = 4.6;
        this.wantFire = false;
        if (!this.hasMoveTarget || this.position.distanceTo(this.moveTarget) < 1.2) {
          this._setState(STATE.COMBAT);
        }
        if (this.health > 45 && this.stateTime > 4) this._setState(STATE.COMBAT);
        break;
      }
    }

    if (this.suppression > 1.15 && this.state === STATE.COMBAT && this.cover) {
      this._setState(STATE.SUPPRESSED);
    }
  }

  _enterCombat() {
    this._setState(STATE.COMBAT);
    this.cover = null;
    this.repathTimer = 0;
  }

  _combat(dt) {
    const target = this.hasTarget ? this.lastKnown : this.lastKnownAge < 5 ? this.lastKnown : null;
    if (!target) {
      this._setState(STATE.ALERT);
      return;
    }
    const sq = this.squad;
    const dist = this.position.distanceTo(target);

    // wounded and outgunned: fall back
    if (this.health < 34 && this.stateTime > 1.5 && this.rng.float() < dt * 0.5) {
      const away = this._v
        .copy(this.position)
        .sub(target)
        .setY(0)
        .normalize()
        .multiplyScalar(9)
        .add(this.position);
      if (this._goTo(away)) {
        this._setState(STATE.RETREAT);
        return;
      }
    }

    // no cover yet, or the current one no longer protects: find one
    if (!this.cover || this.repathTimer <= 0) {
      const pick = this.ai.cover?.pick(this.position, target, {
        id: this.id,
        squad: sq?.members,
        minRange: 7,
        maxRange: 30,
        maxTravel: this.cover ? 12 : 26,
      });
      this.repathTimer = this.rng.range(2.2, 4.5);
      if (pick && pick !== this.cover) {
        this.cover = pick;
        this.coverPos.set(pick.x, pick.y, pick.z);
        this._goTo(this.coverPos);
      }
    }

    // A cover point we cannot actually reach must not mute the agent for ever.
    // `_goTo` fails outright when A* finds no route (which happens for a cover
    // point across an unwalkable seam), and a path can also run out short of the
    // point. The branch below reads "has cover, not standing in it" as "walk,
    // weapon down, hold fire", so without this the agent stands in the open with
    // the player in plain sight and never pulls the trigger.
    if (
      this.cover &&
      !this.hasMoveTarget &&
      !this.pathPending && // still queued behind the frame's A* budget
      this.position.distanceTo(this.coverPos) > 0.85
    ) {
      this.cover = null;
      this.ai.cover?.release(this.id);
      this.repathTimer = Math.min(this.repathTimer, 0.6);
    }

    const atCover = this.cover
      ? this.position.distanceTo(this.coverPos) < 0.85
      : false;

    if (this.cover && !atCover) {
      // moving into position: run, weapon down, no shooting
      this.desiredSpeed = 4.3;
      this.crouch = false;
      this.wantFire = false;
      this.aimWeight = 0.35;
    } else {
      this.desiredSpeed = 0;
      this.hasMoveTarget = false;
      // peek-and-shoot, gated by the squad so they alternate
      const allowed = !sq || sq.requestPeek(this, dt);
      if (this.peekTimer <= 0) {
        this.peeking = allowed && this.targetVisible !== false;
        this.peekTimer = this.peeking ? this.rng.range(1.1, 2.4) : this.rng.range(0.7, 1.8);
        if (this.peeking && this.cover) {
          this.peekSide = this.ai.cover.peekOffset(this.cover, target, this.eyeHeight, this._v2);
          this.coverPos.copy(this._v2);
        }
      }
      this.crouch = this.cover ? !this.cover.high || !this.peeking : false;
      this.aimWeight = this.peeking ? 1 : 0.55;
      this.wantFire = this.peeking && this.targetVisible && this.hasTarget && dist < this.weaponRange;
      // suppressing fire at the last known spot even without a clean shot
      if (!this.wantFire && this.hasTarget && this.lastKnownAge < 2.2 && this.peeking) {
        this.wantFire = this.rng.float() < 0.35;
      }
    }

    // flank when the player has been static and we have friends shooting
    if (
      sq &&
      this.stateTime > 4 &&
      this.grenadeCooldown < 0 === false &&
      sq.canFlank(this) &&
      this.rng.float() < dt * 0.25
    ) {
      const side = this.rng.float() < 0.5 ? 1 : -1;
      const perp = this._v.copy(target).sub(this.position).setY(0).normalize();
      const flank = this._v2
        .set(-perp.z * side, 0, perp.x * side)
        .multiplyScalar(this.rng.range(8, 15))
        .add(this.position)
        .addScaledVector(perp, 4);
      if (this._goTo(flank)) {
        this.cover = null;
        this.ai.cover?.release(this.id);
        this._setState(STATE.FLANK);
        sq.claimFlank(this);
        return;
      }
    }

    // grenade when the player is pinned and we have line of fire
    if (
      this.hasGrenade &&
      this.grenadeCooldown <= 0 &&
      dist > 8 &&
      dist < 26 &&
      this.lastKnownAge < 1.5 &&
      (!sq || sq.requestGrenade(this))
    ) {
      this._throwGrenade(target);
    }
  }

  /* ================================================================== */
  /* movement                                                           */
  /* ================================================================== */

  _goTo(dest) {
    const grid = this.ai.grid;
    if (!grid) {
      this.moveTarget.copy(dest);
      this.hasMoveTarget = true;
      return true;
    }
    const n = this.ai.requestPath(this.position, dest, this.path);
    if (n < 0) {
      // The frame's A* budget is spent. Hold the destination and retry on the
      // next frame instead of failing outright: `_combat` reads a failed _goTo as
      // "that cover point is unreachable" and drops it.
      this._pendingDest.copy(dest);
      this.pathPending = true;
      return false;
    }
    this.pathPending = false;
    if (n === 0) {
      this.hasMoveTarget = false;
      return false;
    }
    this.pathLen = n;
    this.pathIndex = 0;
    this.moveTarget.copy(this.path[n - 1]);
    this.hasMoveTarget = true;
    return true;
  }

  _move(dt) {
    const wp = this.hasMoveTarget && this.pathIndex < this.pathLen ? this.path[this.pathIndex] : null;
    this._steer.set(0, 0, 0);
    let want = 0;

    if (wp) {
      const to = this._v.copy(wp).sub(this.position);
      to.y = 0;
      const d = to.length();
      if (d < (this.pathIndex === this.pathLen - 1 ? 0.45 : 0.75)) {
        this.pathIndex++;
        if (this.pathIndex >= this.pathLen) this.hasMoveTarget = false;
      } else {
        to.multiplyScalar(1 / d);
        this._steer.copy(to);
        want = this.desiredSpeed;
      }
    }

    // local avoidance: push off squadmates and steer around them
    const others = this.ai.agents;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o === this || !o.alive) continue;
      const dx = this.position.x - o.position.x;
      const dz = this.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      const rr = (this.radius + o.radius + 0.42) ** 2;
      if (d2 > rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (1 - d / Math.sqrt(rr)) * 1.5;
      this._steer.x += (dx / d) * push;
      this._steer.z += (dz / d) * push;
      // tangential bias breaks head-on deadlocks deterministically
      this._steer.x += (-dz / d) * push * 0.35 * (this.id % 2 ? 1 : -1);
      this._steer.z += (dx / d) * push * 0.35 * (this.id % 2 ? 1 : -1);
      if (want === 0) want = this.desiredSpeed * 0.35;
    }

    if (this._steer.lengthSq() > 1e-6) this._steer.normalize();

    // speed: ease toward the request so starts and stops have weight
    const targetSpeed = want * (this.crouch ? 0.42 : 1) * (1 - this.suppression * 0.25);
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 7);
    if (this.speed < 0.05) this.speed = 0;

    // facing: look where we are going, or at the threat when engaged
    const engaged =
      this.state === STATE.COMBAT || this.state === STATE.SUPPRESSED || this.hasTarget;
    if (engaged && this.lastKnownAge < 8) {
      this.targetYaw = Math.atan2(this.lastKnown.x - this.position.x, this.lastKnown.z - this.position.z);
    } else if (this.speed > 0.2) {
      this.targetYaw = Math.atan2(this._steer.x, this._steer.z);
    }
    let dy = this.targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    // a big turn while standing still becomes a real turn-in-place step
    if (Math.abs(dy) > 0.9 && this.speed < 0.3) this.animator.turn(dy > 0 ? 1 : -1);
    const turnRate = this.speed > 0.3 ? 6.5 : 3.4;
    this.yaw += Math.max(-turnRate * dt, Math.min(turnRate * dt, dy));

    /* 希望速度を書く。実際の積分は fixedUpdate (120 Hz) — Babylon 版 Character
     * が「速度渡し + 固定ステップ」の約束のため (physics/index.js 参照)。 */
    const c = this.controller;
    if (c) {
      this._wishVx = this._steer.x * this.speed;
      this._wishVz = this._steer.z * this.speed;

      // blocked by something low: vault it
      if (c.lastMoveBlocked && this.speed > 1.5 && this.vaultCooldown <= 0 && this.grounded) {
        this._tryVault();
      }
      if (c.lastMoveBlocked && this.speed > 0.5) {
        this.stuckTimer += dt;
        if (this.stuckTimer > 1.1) {
          this.stuckTimer = 0;
          this.repathTimer = 0;
          if (this.hasMoveTarget) this._goTo(this.moveTarget);
        }
      } else this.stuckTimer = 0;
    } else {
      this.position.x += this._steer.x * this.speed * dt;
      this.position.z += this._steer.z * this.speed * dt;
    }
  }

  _tryVault() {
    const phys = this.phys;
    const fwd = this._v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const low = ray(
      phys,
      this.position.x, this.position.y + 0.35, this.position.z,
      fwd.x, 0, fwd.z, 0.85, phys.MASK.WORLD
    );
    if (!low.hit) return;
    const high = rayAny(
      phys,
      this.position.x, this.position.y + 1.25, this.position.z,
      fwd.x, 0, fwd.z, 1.1, phys.MASK.WORLD
    );
    if (high) return; // a wall, not a ledge
    // landing spot on the other side
    const lx = this.position.x + fwd.x * 1.5;
    const lz = this.position.z + fwd.z * 1.5;
    const y = this.ai.groundAt(lx, lz, this.position.y + 2.2);
    if (!Number.isFinite(y) || Math.abs(y - this.position.y) > 1.3) return;
    this.vaultCooldown = 2.5;
    this.animator.vault(0.8);
    this.vaultFrom = (this.vaultFrom ?? new THREE.Vector3()).copy(this.position);
    this.vaultTo = (this.vaultTo ?? new THREE.Vector3()).set(lx, y, lz);
    this.vaultT = 0;
  }

  /* ================================================================== */
  /* shooting                                                           */
  /* ================================================================== */

  _shoot(dt) {
    // where the gun is pointing: lead toward the target with human error
    const t = this.hasTarget || this.lastKnownAge < 3 ? this.lastKnown : null;
    if (t) {
      // aim at the chest, not the feet
      this._v.set(t.x, t.y + 0.05, t.z);
      const dist = this.position.distanceTo(this._v);
      const wobbleT = this.ctx.time.elapsed * 1.7 + this.id;
      const wob = 0.012 + this.suppression * 0.05;
      this._v.x += Math.sin(wobbleT) * wob * dist * 0.12;
      this._v.y += Math.sin(wobbleT * 1.7 + 1.1) * wob * dist * 0.08;
      this._v.z += Math.cos(wobbleT * 0.8) * wob * dist * 0.12;
      this.aimTarget.lerp(this._v, Math.min(1, dt * 6));
    } else {
      const fwd = this._v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this._v2
        .copy(this.position)
        .addScaledVector(fwd, 12)
        .setY(this.position.y + this.eyeHeight - 0.1);
      this.aimTarget.lerp(this._v2, Math.min(1, dt * 3));
    }

    if (!this.wantFire || this.animator.reloading || this.animator.vaulting) return;
    if (this.ammo <= 0) {
      this.animator.reload(this.variantName === 'irregular' ? 2.9 : 2.35);
      this.ai.emitReload(this);
      this.ammo = this.magSize;
      return;
    }
    if (this.burstLeft <= 0) {
      if (this.burstCooldown > 0) return;
      this.burstLeft = this.rng.int(3, 7);
      this.burstCooldown = this.rng.range(0.45, 1.35) + this.suppression * 0.5;
    }
    if (this.fireCooldown > 0) return;
    this.fireCooldown = 1 / this.fireRate;
    this.burstLeft--;
    this.ammo--;
    this._fireRound();
  }

  _fireRound() {
    const an = this.animator;
    const origin = an.muzzleWorld;
    const dir = this._muzzleDir.copy(an.muzzleDir);
    // cone of fire: worse when suppressed, better the longer we have been aiming
    const spread = this.spread * (1 + this.suppression * 1.5);
    dir.x += this.rng.gauss() * spread;
    dir.y += this.rng.gauss() * spread * 0.8;
    dir.z += this.rng.gauss() * spread;
    dir.normalize();
    an.fire(1);
    this.ai.onAgentFire(this, origin, dir);
  }

  _throwGrenade(target) {
    this.grenadeCooldown = this.rng.range(16, 34);
    this.hasGrenade = false;
    const from = this._v.copy(this.animator.muzzleWorld);
    this.ai.throwGrenade(this, from, target);
  }

  /* ================================================================== */
  /* damage                                                             */
  /* ================================================================== */

  /**
   * Take a hit. NOTE: named `applyDamage`, not `damage` — the weapon's damage
   * value is a field on this object and a method of the same name would be
   * shadowed by it.
   * @param amount  post-falloff damage
   * @param part    'head' | 'torso' | 'arm' | 'leg'
   * @param point   world impact point
   * @param dir     incident direction (unit)
   */
  applyDamage(amount, part, point, dir) {
    if (!this.alive) return;
    this.health -= amount;
    this.alertness = 1;
    this.suppression = Math.min(1.6, this.suppression + 0.35);
    // knowing where it came from
    if (dir) {
      this._v.copy(point).addScaledVector(dir, -14);
      if (this.lastKnownAge > 0.5) {
        this.lastKnown.copy(this._v);
        this.lastKnownAge = 0.4;
      }
    }
    if (this.state === STATE.IDLE || this.state === STATE.PATROL) this._setState(STATE.ALERT);

    if (this.health <= 0) {
      this.die(point, dir, amount);
      return;
    }
    // hit reaction by region, with the side the round came from
    const side = dir ? Math.sign(dir.x * Math.cos(this.yaw) - dir.z * Math.sin(this.yaw)) || 1 : 1;
    const region =
      part === 'head' ? 'head'
        : part === 'arm' ? (this._sideOf(point) < 0 ? 'armR' : 'armL')
          : part === 'leg' ? (this._sideOf(point) < 0 ? 'legR' : 'legL')
            : 'torso';
    this.animator.hit(region, side, Math.min(1.4, 0.5 + amount / 45));
    if (part === 'leg') this.speed *= 0.4;
  }

  /** Which side of the body a world point is on: <0 right, >0 left. */
  _sideOf(p) {
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    return dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
  }

  die(point, dir, amount = 30) {
    if (!this.alive) return;
    this.alive = false;
    this.state = STATE.DEAD;
    this.wantFire = false;
    this.animator.enabled = false;
    this.ai.cover?.release(this.id);
    if (this.controller) this.phys.removeCharacter(this.controller);
    this.controller = null;
    this.hitboxes?.dispose();
    this.hitboxes = null;

    // actor:death のペイロード互換のため、impulse は Three 版と同じスケールで作る
    // (fx の土煙などが読む可能性があるため向きと大きさの意味を保つ)。
    const impulse = this._v2
      .copy(dir ?? this._v.set(0, 0, 1))
      .normalize()
      .multiplyScalar(Math.min(5.5, 1.5 + amount * 0.02));
    const hitPoint = point ?? this._v.copy(this.position).setY(this.position.y + 1.2);

    // ラグドールの代わりに手続きの倒れ込み (deathfall.js に選定理由)。
    // 被弾方向に倒れる。支点は現在の足元。
    this.deathFall.begin(this, dir, this.position.y);

    this.ctx.events.emit('actor:death', {
      actor: this,
      point: hitPoint,
      impulse,
      headshot: false,
    });
    this.deadTime = 0;
  }

  /**
   * 死後のフレーム更新: 倒れ込みモーションを進め、静止したら以後は何もしない
   * (スケルトンへの sync も止まるので死体はゼロコスト)。
   */
  updateDead(dt) {
    this.deadTime += dt;
    if (this.deathFall.t < 0) return;
    const moving = this.deathFall.update(dt, this._deathOut);
    this._applyDeathPose();
    if (!moving) this.deathFall.t = -1; // 完了 — 以後この分岐に入らない
  }

  /** 倒れ込み中のルート姿勢 (倒れ回転 + ひねり) を CPU/Babylon 両方に書く。 */
  _applyDeathPose() {
    const o = this._deathOut;
    // yaw (+ひねり) → 倒れ回転 の順で合成 (ワールド軸回転は premultiply)
    this._deathQ.setFromAxisAngle(UP, this.yaw + o.rootTwist);
    if (o.rootAxis && o.rootAngle > 1e-5) {
      this._deathQ2.setFromAxisAngle(o.rootAxis, o.rootAngle);
      this._deathQ.premultiply(this._deathQ2);
    }
    this.actor.position.set(this.position.x, o.rootY, this.position.z);
    this.actor.quaternion.copy(this._deathQ);
    this.actor.updateMatrix();
    this.actor.updateMatrixWorld();
    this._syncNode();
    syncSkeleton(this.bones, this.bBones, this.skeleton);
  }

  /* ================================================================== */
  /* drive the visual                                                   */
  /* ================================================================== */

  /** CPU 側 actor の変換を Babylon ノードへ写す。 */
  _syncNode() {
    const a = this.actor;
    this.node.position.set(a.position.x, a.position.y, a.position.z);
    this.node.rotationQuaternion.set(a.quaternion.x, a.quaternion.y, a.quaternion.z, a.quaternion.w);
  }

  _drive(dt) {
    // root motion for a vault
    if (this.vaultT !== undefined && this.animator.vaulting && this.vaultFrom) {
      this.vaultT += dt / 0.8;
      const t = Math.min(1, this.vaultT);
      this.position.lerpVectors(this.vaultFrom, this.vaultTo, t);
      this.position.y += Math.sin(t * Math.PI) * 0.42;
      // teleport はカプセル中心基準
      this.controller?.teleport(
        this.position.x,
        this.position.y + this.controller.height * 0.5,
        this.position.z
      );
    }

    this.actor.position.copy(this.position);
    this.actor.quaternion.setFromAxisAngle(UP, this.yaw);
    this.actor.updateMatrix();
    this.actor.updateMatrixWorld();
    this._syncNode();

    const moving = this.speed > 0.25;
    let clip;
    if (this.crouch) clip = moving ? 'crouchWalk' : 'crouchIdle';
    else if (this.speed > 2.6) clip = 'run';
    else if (moving) clip = 'walk';
    else clip = this.health < 35 ? 'hurtIdle' : 'idle';
    this.clip = clip;

    const an = this.animator;
    an.setState({
      clip,
      speed: this.speed,
      crouch: this.crouch,
      aimTarget: this.aimTarget,
      lookTarget: this.hasTarget || this.lastKnownAge < 4 ? this.lastKnown : this.aimTarget,
      aimWeight: this.aimWeight,
      suppress: Math.min(1, this.suppression * 0.8),
    });

    // ANIMATION RATE LOD. The pose write, the three IK chains and the two foot
    // ground rays are the whole per-actor cost, and for an actor that cannot
    // reach a pixel this frame (see AiSystem._updateRelevance) they buy nothing.
    // Evaluate a third as often and hand the solver the accumulated dt, so the
    // stride phase, the recoil envelope and the reload timeline stay on the same
    // clock — nothing skates or slides when the actor becomes visible again, and
    // the frame it does become visible is always a full evaluation because
    // lodIrrelevant is false by then.
    this._animAccum += dt;
    if (this.lodIrrelevant) {
      if (this._animSkip > 0) {
        this._animSkip--;
        return;
      }
      this._animSkip = 2; // one evaluation in three while nothing can see it
    } else {
      this._animSkip = 0;
    }
    an.update(this._animAccum, this.ctx.time.elapsed);
    this._animAccum = 0;
    // CPU で解いた姿勢を Babylon の Skeleton へ (スキップしたフレームは前の
    // 姿勢のまま描かれる — Three 版の挙動と同じ)
    syncSkeleton(this.bones, this.bBones, this.skeleton);
  }

  /** Push the hit capsules onto the animated skeleton. */
  syncHitboxes() {
    if (!this.alive || !this.hitboxes) return;
    this.hitboxes.sync(this.animator);
  }

  dispose() {
    if (this.controller) this.phys?.removeCharacter(this.controller);
    this.controller = null;
    this.hitboxes?.dispose();
    this.hitboxes = null;
    if (this._castingShadow) this._render?.removeShadowCaster(this.mesh);
    // マテリアル/テクスチャは共有なので dispose しない (第 2 引数 false)
    this.mesh.dispose(false, false);
    this.skeleton.dispose();
    this.node.dispose();
  }
}
