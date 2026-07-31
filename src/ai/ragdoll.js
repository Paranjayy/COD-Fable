/**
 * AI — Havok 実ラグドール (敵の死亡演出)。
 *
 * ## なぜ Babylon 標準の `Physics/v2/ragdoll.js` (Ragdoll) を使わないのか
 *
 * 9.18.1 のソースを読んで判断した (2026-07 実査):
 *
 *   1. **関節リミットが dead code**。`RagdollBoneProperties` の min/max は
 *      `_boxConfigs` に読み込まれるだけで、`_initJoints()` の
 *      `new PhysicsConstraint(type, {pivotA, pivotB, axisA, axisB, collision})`
 *      には一切渡されない。既定の HINGE は軸まわり回転が無制限なので、肘も膝も
 *      360° 回る「タコ死体」になる。
 *   2. **フィルタ制御が無い**。PhysicsAggregate が既定フィルタ (全ビット) で
 *      body を作るため、そのままでは弾・視線・CC 掃引の全部に干渉する
 *      (このプロジェクトで最も高くつく事故 — ARCHITECTURE.md 参照)。
 *   3. 生成時に ANIMATED ボディを作り毎フレーム bone→body 同期する構造で、
 *      「死亡時にだけ生やす」使い方だと機構の半分が無駄。しかも ANIMATED の
 *      毎フレームテレポートはこの fork の kinematic broadphase バグ (hitbox.js)
 *      をそのまま踏む。
 *
 * よって PhysicsBody + PhysicsShapeCapsule + Physics6DoFConstraint (関節ごとの
 * 角度リミット付き) で自前構築する。
 *
 * ## 構成
 *
 *   - 11 ボディ (骨盤/胸/頭/上腕×2/前腕×2/大腿×2/脛×2)、10 拘束。死亡の瞬間の
 *     アニメ姿勢からカプセルを起こし、DYNAMIC で生む (ANIMATED 期間なし)。
 *   - ボディを持たない中間ボーン (Spine, Neck, 鎖骨, 手, 足...) は死亡瞬間の
 *     ローカル姿勢のまま親に追従する (riding bones)。
 *   - 毎フレーム body のワールド変換 → アクター空間 → ボーンローカルに逆算して
 *     CPU シム (math3.Bone) へ書き、既存の syncSkeleton 経路で Babylon に渡す。
 *     アクターのルート変換は死亡地点で凍結 (out.rootAngle = 0)。
 *   - 静止判定 (全ボディ低速が 0.45 s 継続、または 8 s 経過) で全ボディを
 *     STATIC に落として同期を止める。以後の死体はゼロコストだが、Havok には
 *     残るので **弾は当たり続ける** (surface:'flesh')。
 *
 * ## フィルタ設計 (要件そのもの — 崩すと過去の事故が再発する)
 *
 *   membership = LAYER.RAGDOLL
 *   collide    = STATIC | PROP | CLIP   (RAGDOLL 自身を含めない)
 *
 *   - 弾 (MASK.BULLET は RAGDOLL を含む) → 当たる。meta は surface:'flesh',
 *     **actor:null** — 死体撃ちで damage:dealt / ヒットマーカーを出さないため。
 *   - AI 視線 (MASK.SIGHT は RAGDOLL を含まない) → 遮らない。
 *   - プレイヤー CC → 掃引・接触とも無効 (CC 側 collide から RAGDOLL ビットを
 *     落としてある — physics/index.js createCharacter 参照)。
 *   - ラグドール同士 / 自己衝突は**意図的に切ってある**。死亡姿勢では前腕と胸の
 *     カプセルが重なっており (パトロールキャリー)、初期貫通の解決インパルスで
 *     体が吹き飛ぶ。隣接ボディは constraint の collision:false でも切れるが、
 *     非隣接 (前腕 vs 胸) はフィルタでしか切れない。
 *
 * ## 決定性
 *
 * 乱数は使わない。生成順・拘束順は PARTS の表順で固定。Havok は同一マシンの
 * run-to-run では再現する (physics/index.js 冒頭) ので、固定ステップ駆動の
 * 範囲で決定的。なお決定性キャプチャの staged 死体は DeathFall.finish() の
 * 手続き経路を使い続ける (deathfall.js のファサード参照)。
 */

import { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody.js';
import { PhysicsShapeCapsule } from '@babylonjs/core/Physics/v2/physicsShape.js';
import { PhysicsMotionType, PhysicsConstraintAxis } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js';
import { Physics6DoFConstraint } from '@babylonjs/core/Physics/v2/physicsConstraint.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3 as BVector3, Quaternion as BQuaternion } from '@babylonjs/core/Maths/math.vector.js';

import { Vector3, Quaternion } from './math3.js';

const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);

/**
 * ボディ定義: [名前, 起点ボーン, 終点ボーン, 半径m, 質量kg, 親ボディ, 関節]
 *
 * 起点ボーンが「このボディが駆動するボーン」。カプセルは起点→終点の線分に張る。
 * 質量は成人 82 kg の解剖学的比率を丸めたもの (骨盤+胸で体幹 32 kg 等)。
 * Havok の拘束ソルバは質量比 ~7:1 (胸 18 : 前腕 2.5) までは安定に解く。
 *
 * 関節 (親ボディとの拘束, 角度は度):
 *   cone : { twist, swing } — 主軸 = ボーンの +Y (骨に沿う)。twist が主軸まわり、
 *           swing が残り 2 軸。肩・股・首など。
 *   hinge: { min, max }     — 主軸 = ボーンの +X。肘・膝。符号はこのリグの
 *           屈曲規約 (deathfall.js の LIMP と同じ): 肘は +X に曲がり (ForearmR
 *           [14,0,0])、膝は -X に曲がる (LegR [-16,0,0])。逆にすると肘が
 *           後ろへ折れる。
 */
const PARTS = [
  ['pelvis',    'Hips',      'Spine1',   0.150, 14.0, null,        null],
  ['chest',     'Spine1',    'Neck',     0.160, 18.0, 'pelvis',    { type: 'cone', twist: 18, swing: 30 }],
  ['head',      'Head',      'HeadTop',  0.100,  6.0, 'chest',     { type: 'cone', twist: 40, swing: 35 }],
  ['upperArmR', 'UpperArmR', 'ForearmR', 0.055,  3.2, 'chest',     { type: 'cone', twist: 30, swing: 72 }],
  ['forearmR',  'ForearmR',  'HandR',    0.048,  2.5, 'upperArmR', { type: 'hinge', min: -4, max: 138 }],
  ['upperArmL', 'UpperArmL', 'ForearmL', 0.055,  3.2, 'chest',     { type: 'cone', twist: 30, swing: 72 }],
  ['forearmL',  'ForearmL',  'HandL',    0.048,  2.5, 'upperArmL', { type: 'hinge', min: -4, max: 138 }],
  ['thighR',    'UpLegR',    'LegR',     0.088,  9.0, 'pelvis',    { type: 'cone', twist: 22, swing: 55 }],
  ['shinR',     'LegR',      'FootR',    0.062,  4.8, 'thighR',    { type: 'hinge', min: -138, max: 4 }],
  ['thighL',    'UpLegL',    'LegL',     0.088,  9.0, 'pelvis',    { type: 'cone', twist: 22, swing: 55 }],
  ['shinL',     'LegL',      'FootL',    0.062,  4.8, 'thighL',    { type: 'hinge', min: -138, max: 4 }],
];

/** bullet:impact / Hit の part 語彙へのマップ (HITBOXES と同じ 4 分類)。 */
const HIT_PART = {
  pelvis: 'torso', chest: 'torso', head: 'head',
  upperArmR: 'arm', forearmR: 'arm', upperArmL: 'arm', forearmL: 'arm',
  thighR: 'leg', shinR: 'leg', thighL: 'leg', shinL: 'leg',
};

/** 静止判定: この速度未満が QUIET_TIME 続いたら凍結。 */
const LIN_SLEEP = 0.08;   // m/s
const ANG_SLEEP = 0.6;    // rad/s
const QUIET_TIME = 0.45;  // s
const MIN_TIME = 1.0;     // s — 生成直後の「まだ立っている」瞬間を静止と誤認しない
const MAX_TIME = 8.0;     // s — 何かに引っ掛かって暴れ続けても打ち切る

export class RagdollFall {
  /**
   * @param rig   共有 Rig (ボーン索引と親子)
   * @param bones このアクターの CPU シムボーン (math3.Bone[])
   */
  constructor(rig, bones) {
    this.rig = rig;
    this.bones = bones;
    this.parts = [];        // { body, shape, node, offQ, offP, boneIndex }
    this.constraints = [];
    this.t = 0;
    this._quiet = 0;
    this._frozen = false;
    this._phys = null;

    /** ボーン索引 → parts 索引 (-1 = riding bone)。 */
    this._drive = new Int16Array(rig.count).fill(-1);
    /** 毎フレームのアクター空間ワールド変換 (親→子の順で埋める)。 */
    this._worldQ = [];
    this._worldP = [];
    for (let i = 0; i < rig.count; i++) {
      this._worldQ.push(new Quaternion());
      this._worldP.push(new Vector3());
    }

    /* scratch — update() はアロケーションゼロ (Hard rule 5) */
    this._qb = new Quaternion();
    this._q1 = new Quaternion();
    this._q2 = new Quaternion();
    this._q3 = new Quaternion();
    this._v1 = new Vector3();
    this._v2 = new Vector3();
    this._bv = new BVector3();
    this._invActorQ = new Quaternion();
    this._actorP = new Vector3();
    this._scale = 1;
  }

  /**
   * 死亡の瞬間に呼ぶ。現在のアニメ姿勢からボディと拘束を起こし、被弾方向の
   * 初速を与える。失敗時は throw する (呼び出し側 = deathfall.js のファサードが
   * 手続きモーションへフォールバックする)。
   *
   * 前提: agent.die() が CC (removeCharacter) とヒットボックスを既に片付けて
   * いること。生きた CC が残ったままだと死体と二重衝突する。
   */
  begin(agent, dir, _groundY) {
    const phys = agent.phys;
    const scene = agent.ctx.scene;
    if (!phys?.plugin) throw new Error('physics unavailable');
    this._phys = phys;
    this._scale = agent.scale ?? 1;

    // ボーンの matrixWorld を現在のローカル姿勢から最新化する。_drive は
    // ローカルの updateMatrix までしかしない (Babylon 側でワールドを解く) ので、
    // ここで明示的に伝播させないと 1 フレーム古い配置でカプセルが立つ。
    agent.actor.updateMatrix();
    agent.actor.updateMatrixWorld();
    this._actorP.copy(agent.actor.position);
    this._invActorQ.copy(agent.actor.quaternion).invert();

    const { LAYER } = phys;
    const fleshProps = phys.SURFACE_PROPS[phys.SURFACE.flesh];

    /* ---- ボディ生成 (PARTS の表順 = 決定的) --------------------------- */
    const head = new Vector3();
    const tail = new Vector3();
    const seg = new Vector3();
    const bodyQ = new Quaternion();
    const boneQ = new Quaternion();
    for (let pi = 0; pi < PARTS.length; pi++) {
      const [name, boneA, boneB, radius, mass] = PARTS[pi];
      const ia = this.rig.index(boneA);
      const ib = this.rig.index(boneB);
      const ea = this.bones[ia].matrixWorld.elements;
      const eb = this.bones[ib].matrixWorld.elements;
      head.set(ea[12], ea[13], ea[14]);
      tail.set(eb[12], eb[13], eb[14]);
      seg.subVectors(tail, head);
      const len = Math.max(0.05, seg.length());
      seg.multiplyScalar(1 / len);
      bodyQ.setFromUnitVectors(UP, seg);

      const node = new TransformNode(`rag_${agent.id}_${name}`, scene);
      node.position.set((head.x + tail.x) * 0.5, (head.y + tail.y) * 0.5, (head.z + tail.z) * 0.5);
      node.rotationQuaternion = new BQuaternion(bodyQ.x, bodyQ.y, bodyQ.z, bodyQ.w);
      // PhysicsBody は生成時に absolutePosition (= world matrix のキャッシュ) を
      // 読む。親なし新規ノードは自動計算されないため、明示的に確定させないと
      // body が原点に生成される (physics/index.js addRigidBody と同じ罠)。
      node.computeWorldMatrix(true);

      const r = radius * this._scale;
      // カプセル全長 = 線分長 + 2r になるので、関節の食い込みを抑えるため
      // 円筒部を少し詰める。
      const half = Math.max(0.02, len * 0.5 - r * 0.35);
      const shape = new PhysicsShapeCapsule(
        new BVector3(0, -half, 0),
        new BVector3(0, half, 0),
        r,
        scene
      );
      shape.filterMembershipMask = LAYER.RAGDOLL;
      // 自己衝突なし (冒頭コメント)。世界とクリップにだけ乗る。
      shape.filterCollideMask = LAYER.STATIC | LAYER.PROP | LAYER.CLIP;
      shape.material = { friction: fleshProps.friction, restitution: fleshProps.restitution };

      const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, scene);
      body.shape = shape;
      body.setMassProperties({ mass: mass * this._scale });
      // 減衰は「服を着た人体が路面で滑らない」寄りに強め。跳ねる死体は一発で嘘になる。
      body.setLinearDamping(0.2);
      body.setAngularDamping(0.8);

      // 弾の Hit 語彙に載せる。actor:null は意図的 (冒頭コメント)。
      phys.registerBodyMeta(body, {
        surface: 'flesh',
        layer: LAYER.RAGDOLL,
        actor: null,
        part: HIT_PART[name],
      });

      // body フレームでのボーンオフセット (体が動いてもボーンを復元できるように)
      this.bones[ia].getWorldQuaternion(boneQ);
      const offQ = new Quaternion().copy(bodyQ).invert().multiply(boneQ);
      const offP = new Vector3(
        head.x - node.position.x, head.y - node.position.y, head.z - node.position.z
      ).applyQuaternion(this._q1.copy(bodyQ).invert());

      this._drive[ia] = pi;
      this.parts.push({ name, body, shape, node, offQ, offP, boneIndex: ia });
    }

    /* ---- 拘束 (親ボディ → 子ボディ, 関節 = 子ボーンの付け根) ----------- */
    for (let pi = 0; pi < PARTS.length; pi++) {
      const [, boneA, , , , parentName, joint] = PARTS[pi];
      if (!parentName || !joint) continue;
      const child = this.parts[pi];
      const par = this.parts.find((p) => p.name === parentName);

      const ia = this.rig.index(boneA);
      const e = this.bones[ia].matrixWorld.elements;
      const pivotW = new Vector3(e[12], e[13], e[14]);
      // ボーンのワールド基底 (正規化してスケールを除く)
      const bx = new Vector3(e[0], e[1], e[2]).normalize();
      const by = new Vector3(e[4], e[5], e[6]).normalize();
      // cone は骨に沿う +Y が主軸 (twist 軸)、hinge は +X が屈曲軸
      const axW = joint.type === 'hinge' ? bx : by;
      const perpW = joint.type === 'hinge' ? by : bx;

      const limits = [
        // 並進は 3 軸ともロック (min=max=0 → Havok 側で LOCKED)
        { axis: PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0 },
        { axis: PhysicsConstraintAxis.LINEAR_Y, minLimit: 0, maxLimit: 0 },
        { axis: PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0 },
      ];
      if (joint.type === 'hinge') {
        limits.push(
          { axis: PhysicsConstraintAxis.ANGULAR_X, minLimit: joint.min * DEG, maxLimit: joint.max * DEG },
          { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: -4 * DEG, maxLimit: 4 * DEG },
          { axis: PhysicsConstraintAxis.ANGULAR_Z, minLimit: -4 * DEG, maxLimit: 4 * DEG }
        );
      } else {
        limits.push(
          { axis: PhysicsConstraintAxis.ANGULAR_X, minLimit: -joint.twist * DEG, maxLimit: joint.twist * DEG },
          { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: -joint.swing * DEG, maxLimit: joint.swing * DEG },
          { axis: PhysicsConstraintAxis.ANGULAR_Z, minLimit: -joint.swing * DEG, maxLimit: joint.swing * DEG }
        );
      }

      const toLocal = (bodyPart, w) => {
        const q = this._q1.set(
          bodyPart.node.rotationQuaternion.x, bodyPart.node.rotationQuaternion.y,
          bodyPart.node.rotationQuaternion.z, bodyPart.node.rotationQuaternion.w
        ).invert();
        return this._v1.copy(w).applyQuaternion(q);
      };
      const pivotA = (() => { const v = toLocal(par, this._v2.subVectors(pivotW, this._pos(par))); return new BVector3(v.x, v.y, v.z); })();
      const axisA = (() => { const v = toLocal(par, axW); return new BVector3(v.x, v.y, v.z); })();
      const perpA = (() => { const v = toLocal(par, perpW); return new BVector3(v.x, v.y, v.z); })();
      const pivotB = (() => { const v = toLocal(child, this._v2.subVectors(pivotW, this._pos(child))); return new BVector3(v.x, v.y, v.z); })();
      const axisB = (() => { const v = toLocal(child, axW); return new BVector3(v.x, v.y, v.z); })();
      const perpB = (() => { const v = toLocal(child, perpW); return new BVector3(v.x, v.y, v.z); })();

      const c = new Physics6DoFConstraint(
        {
          pivotA, pivotB,
          axisA, axisB,
          perpAxisA: perpA, perpAxisB: perpB,
          // 隣接ボディ同士の衝突は拘束側でも切る (初期は必ず重なっているため)
          collision: false,
        },
        limits,
        scene
      );
      par.body.addConstraint(child.body, c);
      this.constraints.push(c);
    }

    /* ---- 初速 --------------------------------------------------------- */
    // 全身: 死亡時の移動速度 + 被弾方向へ押される成分。被弾部位のボディには
    // さらに強い初速を足して「撃たれた側から崩れる」を出す。決定的 (rng 不使用)。
    const vx = agent.velocity?.x ?? 0;
    const vz = agent.velocity?.z ?? 0;
    let dx = dir?.x ?? -Math.sin(agent.yaw);
    let dz = dir?.z ?? -Math.cos(agent.yaw);
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    // 被弾部位 (直前の入口 impact — ai/index.js が覚えている) に強い初速。
    // torso 被弾と部位不明は胸に集約する。
    const struck =
      (agent.ai?._lastImpactActor === agent ? agent.ai._lastImpactPart : null) ?? 'torso';
    for (const p of this.parts) {
      const hitThis =
        struck === 'head' ? p.name === 'head'
          : struck === 'torso' ? p.name === 'chest'
            : HIT_PART[p.name] === struck; // arm / leg は左右 4 ボディまとめて
      const kick = hitThis ? (p.name === 'head' ? 4.2 : 3.0) : 1.3;
      this._bv.set(vx + dx * kick, 0, vz + dz * kick);
      p.body.setLinearVelocity(this._bv);
    }

    this.t = 0;
    this._quiet = 0;
    this._frozen = false;
  }

  /** part のワールド位置 (scratch を汚さない読み出し)。 */
  _pos(part) {
    return part.node.position;
  }

  /**
   * 1 フレーム分: body の変換をボーンローカルへ逆算して CPU シムに書く。
   * 呼び出し側 (agent.updateDead → _applyDeathPose) が syncSkeleton まで行う。
   * @returns true = まだ動いている / false = 静止 (以後呼ばれない)
   */
  update(dt, out) {
    out.rootAngle = 0;
    out.rootAxis = null;
    out.rootTwist = 0;
    out.rootY = this._actorP.y;
    if (this._frozen) return false;
    this.t += dt;

    const rig = this.rig;
    const invS = 1 / this._scale;
    for (let i = 0; i < rig.count; i++) {
      const pi = rig.parent[i];
      const pQ = pi < 0 ? null : this._worldQ[pi];
      const pP = pi < 0 ? null : this._worldP[pi];
      const bone = this.bones[i];
      const di = this._drive[i];
      if (di >= 0) {
        const node = this.parts[di].node;
        const nq = node.rotationQuaternion;
        this._qb.set(nq.x, nq.y, nq.z, nq.w);
        // body → ボーンワールド
        this._q1.multiplyQuaternions(this._qb, this.parts[di].offQ);
        this._v1.copy(this.parts[di].offP).applyQuaternion(this._qb);
        this._v1.x += node.position.x;
        this._v1.y += node.position.y;
        this._v1.z += node.position.z;
        // ワールド → アクター空間 (アクターは死亡地点で凍結、均一スケール)
        this._q2.multiplyQuaternions(this._invActorQ, this._q1);
        this._v2.subVectors(this._v1, this._actorP).applyQuaternion(this._invActorQ).multiplyScalar(invS);
        // アクター空間 → 親ボーンローカル
        if (pQ) {
          this._q3.copy(pQ).invert();
          bone.quaternion.multiplyQuaternions(this._q3, this._q2);
          bone.position.copy(this._v2).sub(pP).applyQuaternion(this._q3);
        } else {
          bone.quaternion.copy(this._q2);
          bone.position.copy(this._v2);
        }
        bone.updateMatrix();
        this._worldQ[i].copy(this._q2);
        this._worldP[i].copy(this._v2);
      } else {
        // riding bone: 死亡瞬間のローカルのまま親に追従 (ボーンは書き換えない)
        if (pQ) {
          this._worldQ[i].multiplyQuaternions(pQ, bone.quaternion);
          this._worldP[i].copy(bone.position).applyQuaternion(pQ).add(pP);
        } else {
          this._worldQ[i].copy(bone.quaternion);
          this._worldP[i].copy(bone.position);
        }
      }
    }

    /* ---- 静止判定 ----------------------------------------------------- */
    let maxLin = 0;
    let maxAng = 0;
    for (const p of this.parts) {
      p.body.getLinearVelocityToRef(this._bv);
      maxLin = Math.max(maxLin, this._bv.lengthSquared());
      p.body.getAngularVelocityToRef(this._bv);
      maxAng = Math.max(maxAng, this._bv.lengthSquared());
    }
    const quietNow = maxLin < LIN_SLEEP * LIN_SLEEP && maxAng < ANG_SLEEP * ANG_SLEEP;
    this._quiet = quietNow ? this._quiet + dt : 0;
    if ((this.t > MIN_TIME && this._quiet >= QUIET_TIME) || this.t >= MAX_TIME) {
      this._freeze();
      return false;
    }
    return true;
  }

  /**
   * 全ボディを STATIC に落として演算コストを消す。body は Havok に残るので
   * 死体は撃てるまま (surface:'flesh')。dispose とは別 — dispose は消滅。
   */
  _freeze() {
    if (this._frozen) return;
    this._frozen = true;
    for (const p of this.parts) {
      try {
        p.body.setMotionType(PhysicsMotionType.STATIC);
      } catch {
        /* 物理エンジンが先に片付いた場合は無視 */
      }
    }
  }

  /** ボディ・拘束・メタ登録を全部消す。AiSystem.dispose / ファサードが呼ぶ。 */
  dispose() {
    for (const c of this.constraints) {
      try { c.dispose(); } catch { /* engine teardown 順に依存しない */ }
    }
    this.constraints.length = 0;
    for (const p of this.parts) {
      this._phys?.unregisterBodyMeta(p.body);
      try { p.body.dispose(); } catch { /* 同上 */ }
      try { p.shape.dispose(); } catch { /* 同上 */ }
      p.node.dispose();
    }
    this.parts.length = 0;
  }
}
