/**
 * AI — 部位ヒットボックス (Havok キネマティックカプセル)。
 *
 * Three 版の physics には `addCollider()` (クエリ専用カプセル) があったが、
 * Babylon/Havok 版 physics は静的ワールド・キャラクタ・剛体しか公開していない。
 * 弾は `phys.fireBullet()` の Havok レイキャストで当たりを取るので、AI が
 * 撃たれるためには **Havok ワールドの中に部位カプセルが実在する**必要がある。
 * そこで各部位を ANIMATED (キネマティック) の PhysicsBody として持ち、毎フレーム
 * ボーン位置に追従させる。
 *
 * ## フィルタ設計 — ここを崩すと二通りの壊れ方をする
 *
 * Havok のフィルタは対称: (A.membership & B.collideWith) && (B.membership & A.collideWith)。
 * レイクエリは membership=~0 で飛んでくる (physics.raycast の既定) ため:
 *
 *   - hitbox.membership = LAYER.ACTOR
 *       → MASK.BULLET (ACTOR を含む) のレイには当たり、MASK.SIGHT / WORLD
 *         (ACTOR を含まない) のレイからは見えない。視線や nav のレイが味方の
 *         体で遮られない、という Three 版と同じ挙動がこれで出る。
 *   - hitbox.collideWith = LAYER.PLAYER (非ゼロでありさえすればレイは通る)
 *       → 静的ワールドや DEBRIS とは相互マスクが噛み合わず物理接触しない。
 *
 * さらに **AI 自身の CharacterController が自分のヒットボックスに衝突すると
 * 一歩も歩けなくなる**。CC の掃引クエリは CC 自身の shape のフィルタを使う
 * (characterController.js の castWithCollectors) ので、agent.js が CC shape に
 *   membership = LAYER.CLIP / collideWith = MASK.CHARACTER
 * を設定して ACTOR 層を掃引対象から外している。この 2 箇所はセットで意味を
 * 持つ — 片方だけ変えないこと。
 *
 * ## phys._meta への登録について
 *
 * Hit に actor / part / surface を載せるのは physics の `_meta` マップだが、
 * 外部から登録する公開 API が (まだ) 無い。physics 側の実装を変えずに済ませる
 * ため、ここでは _meta に直接 set する。physics が公開 API (addCollider 相当) を
 * 生やしたらそちらへ移行すること。
 */

import { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody.js';
import { PhysicsShapeCapsule } from '@babylonjs/core/Physics/v2/physicsShape.js';
import { PhysicsMotionType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3 as BVector3, Quaternion as BQuaternion } from '@babylonjs/core/Maths/math.vector.js';

import { Vector3, Quaternion } from './math3.js';

const UP = new Vector3(0, 1, 0);

export class HitboxSet {
  /**
   * @param phys   physics サブシステム
   * @param scene  Babylon Scene
   * @param agent  所有者 (Hit.actor に載る)
   * @param specs  [part, boneA, boneB, radius, damageScale][] (agent.js の HITBOXES)
   * @param rig    バインド長を測るための Rig
   * @param scale  アクターの均一スケール
   */
  constructor(phys, scene, agent, specs, rig, scale) {
    this.phys = phys;
    this.parts = [];
    this._va = new Vector3();
    this._vb = new Vector3();
    this._dir = new Vector3();
    this._q = new Quaternion();
    /** SetQTransform 用スクラッチ [[x,y,z],[qx,qy,qz,qw]] (毎フレーム再利用)。 */
    this._transform = [[0, 0, 0], [0, 0, 0, 1]];

    for (const [part, a, b, r, dmg] of specs) {
      const ia = rig.index(a);
      const ib = rig.index(b);
      const len = rig.bindPos[ia].distanceTo(rig.bindPos[ib]) * scale;
      const half = Math.max(0.02, len * 0.5);
      const radius = r * scale;

      const node = new TransformNode(`hb_${agent.id}_${part}`, scene);
      node.rotationQuaternion = BQuaternion.Identity();
      const shape = new PhysicsShapeCapsule(
        new BVector3(0, -half, 0),
        new BVector3(0, half, 0),
        radius,
        scene
      );
      shape.filterMembershipMask = phys.LAYER.ACTOR;
      shape.filterCollideMask = phys.LAYER.PLAYER; // レイを通すための非ゼロ値 (冒頭コメント参照)
      const body = new PhysicsBody(node, PhysicsMotionType.ANIMATED, false, scene);
      body.shape = shape;
      /**
       * 追従は sync() が自前で行う (下のコメント参照) ため、Babylon の
       * pre-step (disablePreStep=false → 毎ステップ SetQTransform) は使わない。
       * body→node の書き戻し (executeStep 末尾の sync) も不要なので切る。
       */
      body.disableSync = true;

      // Hit.actor / Hit.part / surface='flesh' を載せる (冒頭コメント参照)
      phys._meta.set(body, {
        surfaceIndex: phys.SURFACE.flesh,
        surface: 'flesh',
        layer: phys.LAYER.ACTOR,
        mesh: null,
        actor: agent,
        part,
      });

      this.parts.push({ part, a, b, node, body, shape, half, damageScale: dmg });
    }
  }

  /**
   * アニメーション済みのボーン位置へ全カプセルを追従させる。毎フレーム呼ぶ。
   *
   * ## なぜ Babylon の pre-step ではなく自前テレポート + 再登録なのか (実測)
   *
   * この Babylon fork の Havok では、ワールド追加後の kinematic ボディを
   * SetQTransform (pre-step の TELEPORT 経路も同じ) で動かすと、**ボディの
   * 実座標は動くのにクエリ用 broadphase が更新されず、レイキャストに二度と
   * 当たらなくなる** (最小再現で確認済み: 0.05m/frame の微小移動でも発生し、
   * 以後どの座標でも hit しない)。SetTargetQTransform (ACTION 経路) は逆に
   * ボディが目標に追従しなかった。
   *
   * 回避策: SetQTransform で座標を書いた直後に HP_World_RemoveBody →
   * HP_World_AddBody で broadphase へ登録し直す。42 ボディ (7×6 体) × 60Hz で
   * 問題ないコストであることは capture で確認済み。plugin の内部 (_hknp) に
   * 触れているのは公開 API に相当経路が無いため — Babylon 側でこのバグが
   * 直ったら disablePreStep=false に戻してこのメソッドを縮退させること。
   */
  sync(animator) {
    const plugin = this.phys.plugin;
    const hk = plugin._hknp;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      animator.bonePos(p.a, this._va);
      animator.bonePos(p.b, this._vb);
      const n = p.node;
      n.position.set(
        (this._va.x + this._vb.x) * 0.5,
        (this._va.y + this._vb.y) * 0.5,
        (this._va.z + this._vb.z) * 0.5
      );
      this._dir.subVectors(this._vb, this._va);
      if (this._dir.lengthSq() > 1e-10) {
        this._dir.normalize();
        this._q.setFromUnitVectors(UP, this._dir);
        n.rotationQuaternion.set(this._q.x, this._q.y, this._q.z, this._q.w);
      }
      // Havok へテレポート + broadphase 再登録 (上のコメント参照)
      const pd = p.body._pluginData;
      const region = pd.worldRegion ?? plugin._worldRegions[0];
      const o = region.floatingOrigin;
      this._transform[0][0] = n.position.x - o.x;
      this._transform[0][1] = n.position.y - o.y;
      this._transform[0][2] = n.position.z - o.z;
      this._transform[1][0] = this._q.x;
      this._transform[1][1] = this._q.y;
      this._transform[1][2] = this._q.z;
      this._transform[1][3] = this._q.w;
      hk.HP_Body_SetQTransform(pd.hpBodyId, this._transform);
      hk.HP_World_RemoveBody(region.world, pd.hpBodyId);
      hk.HP_World_AddBody(region.world, pd.hpBodyId, false);
    }
  }

  /** 部位名 → ダメージ倍率 ('head' 4.0 等)。見つからなければ 1。 */
  damageScaleFor(part) {
    for (const p of this.parts) if (p.part === part) return p.damageScale;
    return 1;
  }

  dispose() {
    for (const p of this.parts) {
      this.phys._meta.delete(p.body);
      p.body.dispose();
      p.shape.dispose();
      p.node.dispose();
    }
    this.parts.length = 0;
  }
}
