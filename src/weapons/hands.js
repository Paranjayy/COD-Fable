import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector.js';

import { box, blob, latheZ, dome, ring, mergeAll, meshFromGeo } from './geometry.js';
import { setEulerXYZ } from './vmath.js';

/**
 * First-person arms — Babylon 移植版。
 *
 * 構造・寸法・ポーズは Three 版から無改変で持ち越し (骨長 330/300 mm に 10%
 * チートしてある理由、C-clamp の解析経緯などは各コメント参照)。変わったのは
 * シーングラフ API (Object3D→TransformNode) と数学型だけ。
 *
 * Babylon 移植で **落とした** もの:
 *  - bakeSurfaceMasks / bakeContactAO — 頂点カラーの摩耗/汚れ/AO マスクは
 *    Three 版のカスタムシェーダ専用の仕組みで、Babylon の materials 鍛冶場には
 *    受け口が無い。かわりにマテリアル側 (materials.js) の焼き込みテクスチャが
 *    布の質感を担う。fitToCylinder (指先の接触ソルブ) は純粋な変換計算なので残す。
 *
 * Hand-local space: -Z along the fingers, +Y out of the back of the hand,
 * +X toward the thumb (a right hand; the left is mirrored).
 */

/**
 * Humerus and forearm+wrist lengths, in metres.
 * 実測 300/272 では支え手が 99.5% 伸展になり肘がロックする (Three 版の実測)。
 * 10% チートして 330/300 — 肘の曲がりが見え、しかも肘はフレームの外へ出る。
 */
const L_UPPER = 0.33;
const L_FORE = 0.3;

/* -------------------------------------------------------------------------- */
/*  geometry (Three 版と同一の寸法・プロファイル)                              */
/* -------------------------------------------------------------------------- */

/** One finger segment: a tapered, chamfered capsule with a joint crease. */
function segment(len, r0, r1) {
  const g = latheZ(
    [
      [0, 0],
      [0, r0 * 0.86],
      [r0 * 0.5, r0],
      [len * 0.42, r0 * 0.99],
      [len * 0.55, r1 * 1.04],
      [len - r1 * 0.7, r1],
      [len - r1 * 0.2, r1 * 0.8],
      [len, r1 * 0.35],
      [len, 0],
    ],
    12
  );
  g.scale(1, 0.88, 1); // fingers are wider than they are deep
  g.rotateY(Math.PI); // extend along -Z
  return g;
}

/** Padded segment cover on the dorsal side (glove reinforcement). */
function segmentPad(len, r) {
  const g = blob(r * 1.55, r * 0.55, len * 0.78, r * 0.25, 2);
  g.translate(0, r * 0.78, -len * 0.46);
  return g;
}

/**
 * Stitched seam down the side of a finger segment。40 px の手で 4 本の指が
 * 1 枚のパドルに融けるのを防ぐ唯一の分離線 (Three 版の実測)。
 */
function segmentSeam(len, r0, r1, sx) {
  const g = box(0.0015, (r0 + r1) * 0.34, len * 0.86, 0.0003, 1);
  g.translate(sx * (r0 + r1) * 0.49, r0 * 0.1, -len * 0.47);
  return g;
}

/**
 * Build one finger as three nested joints so it can curl.
 * @returns {{root: TransformNode, joints: TransformNode[]}}
 */
function buildFinger(scene, materials, spec) {
  const { lengths, radii, curl } = spec;
  const root = new TransformNode('finger', scene);
  const joints = [];
  let parent = root;
  for (let i = 0; i < 3; i++) {
    const j = new TransformNode(`finger-j${i}`, scene);
    j.rotation.x = -curl[i];
    j.parent = parent;
    const mesh = meshFromGeo('finger-seg', segment(lengths[i], radii[i], radii[i + 1]), materials.glove, scene);
    mesh.parent = j;
    if (i < 2) {
      const seams = mergeAll([
        segmentSeam(lengths[i], radii[i], radii[i + 1], 1),
        segmentSeam(lengths[i], radii[i], radii[i + 1], -1),
      ]);
      meshFromGeo('finger-seam', seams, materials.seam ?? materials.glove, scene).parent = j;
      meshFromGeo('finger-pad', segmentPad(lengths[i], radii[i]), materials.pad, scene).parent = j;
    } else {
      // fingertip grip patch on the palm side
      const tip = blob(radii[i] * 1.5, radii[i] * 0.5, lengths[i] * 0.7, radii[i] * 0.2, 2);
      tip.translate(0, -radii[i] * 0.72, -lengths[i] * 0.45);
      meshFromGeo('finger-tip', tip, materials.pad, scene).parent = j;
    }
    const next = new TransformNode(`finger-n${i}`, scene);
    next.position.z = -lengths[i];
    next.parent = j;
    parent = next;
    joints.push(j);
  }
  return { root, joints };
}

/**
 * Glove: palm, thumb web, knuckle plate, wrist strap.
 * カバレッジ予算 (甲の 55% 以下しか装甲で覆わない) は Three 版の批評対応の結論。
 */
function buildGlove(scene, materials, opts = {}) {
  const scale = opts.scale ?? 1;
  const w = 0.088 * scale;
  const h = 0.032 * scale;
  const palmLen = 0.098 * scale;
  const root = new TransformNode('glove', scene);

  const shell = [];
  const palm = blob(w, h, palmLen * 0.62, 0.012 * scale, 3);
  palm.translate(0, 0, -palmLen * 0.66);
  shell.push(palm);
  const palmRear = blob(w * 0.83, h * 0.96, palmLen * 0.52, 0.012 * scale, 3);
  palmRear.translate(0, -h * 0.01, -palmLen * 0.26);
  shell.push(palmRear);
  const thenar = blob(w * 0.42, h * 0.92, palmLen * 0.6, 0.014 * scale, 3);
  thenar.translate(w * 0.3, -h * 0.06, -palmLen * 0.3);
  shell.push(thenar);
  const heel = blob(w * 0.92, h * 0.86, 0.03 * scale, 0.012 * scale, 3);
  heel.translate(0, -h * 0.04, -0.012 * scale);
  shell.push(heel);
  for (let i = 0; i < 4; i++) {
    const x = w * (0.34 - i * 0.225);
    const k = dome(0.0072 * scale, 10, 0.62);
    k.rotateX(-Math.PI / 2);
    k.translate(x, h * 0.42, -palmLen * 0.94);
    shell.push(k);
  }
  meshFromGeo('glove-shell', mergeAll(shell), materials.glove, scene).parent = root;

  // Dorsal armour: 4 分割ナックルキャップ + 小さい中手骨パネル (計 ~30%)。
  const pads = [];
  for (let i = 0; i < 4; i++) {
    const x = w * (0.335 - i * 0.223);
    const cap = blob(w * 0.17, h * 0.3, palmLen * 0.3, 0.005 * scale, 3);
    const drop = Math.abs(i - 1.5) > 1 ? h * 0.055 : 0;
    cap.translate(x, h * 0.46 - drop, -palmLen * 0.82);
    pads.push(cap);
  }
  const backPanel = blob(w * 0.44, h * 0.17, palmLen * 0.22, 0.005 * scale, 3);
  backPanel.translate(0, h * 0.44, -palmLen * 0.4);
  pads.push(backPanel);
  const patch = blob(w * 0.82, h * 0.18, palmLen * 0.66, 0.006 * scale, 3);
  patch.translate(0, -h * 0.52, -palmLen * 0.48);
  pads.push(patch);
  meshFromGeo('glove-pads', mergeAll(pads), materials.pad, scene).parent = root;

  // Seams down the sides of the hand.
  const seams = [];
  for (const sx of [-1, 1]) {
    const s = box(0.0016 * scale, h * 0.5, palmLen * 0.8, 0.0004, 1);
    s.translate(sx * w * 0.5, 0, -palmLen * 0.5);
    seams.push(s);
  }
  meshFromGeo('glove-seams', mergeAll(seams), materials.pad, scene).parent = root;

  // Wrist cuff + strap.
  const cuff = latheZ(
    [
      [0, w * 0.44],
      [0.004 * scale, w * 0.47],
      [0.03 * scale, w * 0.46],
      [0.034 * scale, w * 0.42],
    ],
    16
  );
  cuff.scale(1, 0.82, 1);
  const cuffMesh = meshFromGeo('glove-cuff', cuff, materials.glove, scene);
  cuffMesh.position.z = 0.004 * scale;
  cuffMesh.parent = root;
  const strap = latheZ(
    [
      [0, w * 0.47],
      [0.0022, w * 0.5],
      [0.009 * scale, w * 0.5],
      [0.0112 * scale, w * 0.47],
    ],
    16
  );
  strap.scale(1, 0.82, 1);
  const strapMesh = meshFromGeo('glove-strap', strap, materials.pad, scene);
  strapMesh.position.z = 0.02 * scale;
  strapMesh.parent = root;

  return root;
}

/**
 * Thumb: two segments on the +X side.
 * 近位セグメントが中手骨を兼ねるので 50 mm (38 では手guard に 13 mm 届かない —
 * Three 版で 21×15 グリッド走査までやって確かめた到達距離の問題)。
 */
const THUMB = { l0: 0.05, l1: 0.032, r0: 0.0115, r1: 0.0102, r2: 0.0078 };

function buildThumb(scene, materials, scale = 1, spec = THUMB) {
  const root = new TransformNode('thumb', scene);
  const j1 = new TransformNode('thumb-j1', scene);
  j1.parent = root;
  meshFromGeo('thumb-s1', segment(spec.l0 * scale, spec.r0 * scale, spec.r1 * scale), materials.glove, scene).parent = j1;
  meshFromGeo('thumb-pad1', segmentPad(spec.l0 * scale, spec.r0 * scale), materials.pad, scene).parent = j1;
  meshFromGeo(
    'thumb-seams',
    mergeAll([
      segmentSeam(spec.l0 * scale, spec.r0 * scale, spec.r1 * scale, 1),
      segmentSeam(spec.l0 * scale, spec.r0 * scale, spec.r1 * scale, -1),
    ]),
    materials.seam ?? materials.glove,
    scene
  ).parent = j1;
  const j2 = new TransformNode('thumb-j2', scene);
  j2.position.z = -spec.l0 * scale;
  j2.parent = j1;
  meshFromGeo('thumb-s2', segment(spec.l1 * scale, spec.r1 * scale, spec.r2 * scale), materials.glove, scene).parent = j2;
  const pad = blob(spec.r2 * 1.6 * scale, spec.r2 * 0.55 * scale, spec.l1 * 0.66 * scale, 0.0012, 2);
  pad.translate(0, -spec.r2 * 0.78 * scale, -spec.l1 * 0.45 * scale);
  meshFromGeo('thumb-tip', pad, materials.pad, scene).parent = j2;
  const nail = blob(0.011 * scale, 0.0035 * scale, 0.016 * scale, 0.0012, 2);
  nail.translate(0, spec.r2 * scale, -0.016 * scale);
  meshFromGeo('thumb-nail', nail, materials.pad, scene).parent = j2;
  return { root, joints: [j1, j2] };
}

/**
 * Tapered sleeve with fold rings, an elbow pad and a rolled cuff.
 * 32 角形 (ファセットの矢高 0.28 px、AA 以下)・3 つの膨らみ変曲点・楕円で
 * ジッタした折りリング — 「パイプに見えない袖」の条件は Three 版の実測どおり。
 */
function buildSleeve(scene, material, len, r0, r1, opts = {}) {
  const parts = [];
  const SEG = 32;
  const shell = latheZ(
    [
      [0, 0],
      [0, r0 * 0.55],
      [-0.004, r0 * 0.82],
      [-0.006, r0 * 0.98],
      [0.004, r0],
      [len * 0.16, r0 * 1.03],
      [len * 0.34, r0 * 0.9],
      [len * 0.52, (r0 + r1) * 0.5],
      [len * 0.72, r1 * 1.1],
      [len - 0.016, r1 * 1.0],
      [len - 0.005, r1 * 1.07],
      [len, r1 * 0.98],
      [len + 0.003, r1 * 0.8],
      [len + 0.004, 0],
    ],
    SEG
  );
  parts.push(shell);
  const joint = latheZ(
    [
      [len - r1 * 1.1, 0],
      [len - r1 * 0.9, r1 * 0.75],
      [len - r1 * 0.2, r1 * 1.04],
      [len + r1 * 0.5, r1 * 0.9],
      [len + r1 * 0.8, r1 * 0.4],
      [len + r1 * 0.85, 0],
    ],
    20
  );
  joint.scale(1, 0.94, 1);
  parts.push(joint);
  const folds = opts.folds ?? 3;
  for (let i = 0; i < folds; i++) {
    const t = 0.14 + (i / Math.max(1, folds - 1)) * 0.7;
    // deterministic wobble, so captures stay byte-identical
    const j = Math.sin(i * 2.399 + 0.7) * 0.5 + Math.sin(i * 5.13) * 0.25;
    const r = (r0 + (r1 - r0) * t) * (1 + j * 0.06);
    const f = ring(r * 0.985, r * (0.085 + j * 0.03), 24, 6);
    f.rotateX(Math.PI / 2);
    f.rotateY(j * 0.12);
    f.scale(1, 0.93, 1);
    f.translate(0, 0, len * t + j * 0.004);
    parts.push(f);
  }
  for (const sx of [-1, 1]) {
    const w = latheZ(
      [
        [len * 0.2, 0],
        [len * 0.3, r0 * 0.16],
        [len * 0.55, r0 * 0.2],
        [len * 0.78, r0 * 0.13],
        [len * 0.86, 0],
      ],
      10
    );
    w.scale(1, 0.5, 1);
    w.rotateZ(sx * 0.4);
    w.translate(sx * (r0 + r1) * 0.46, -(r0 + r1) * 0.1, 0);
    parts.push(w);
  }
  if (opts.elbowPad) {
    const pad = blob(r0 * 1.5, r0 * 0.6, len * 0.3, r0 * 0.3, 3);
    pad.translate(0, r0 * 0.75, len * 0.12);
    parts.push(pad);
  }
  if (opts.cuff) {
    const cuff = latheZ(
      [
        [len - 0.032, r1 * 1.02],
        [len - 0.029, r1 * 1.17],
        [len - 0.019, r1 * 1.16],
        [len - 0.016, r1 * 1.08],
        [len - 0.012, r1 * 1.08],
        [len - 0.009, r1 * 1.18],
        [len - 0.003, r1 * 1.17],
        [len, r1 * 1.02],
      ],
      SEG
    );
    parts.push(cuff);
  }
  const g = mergeAll(parts);
  g.rotateY(Math.PI); // extend along -Z, like the bones
  return meshFromGeo('sleeve', g, material, scene);
}

/* -------------------------------------------------------------------------- */
/*  arm rig                                                                   */
/* -------------------------------------------------------------------------- */

const _t = new Vector3();
const _dir = new Vector3();
const _perp = new Vector3();
const _elbow = new Vector3();
const _up = new Vector3();
const _pole = new Vector3();
const _hp = new Vector3();
const _bx = new Vector3();
const _by = new Vector3();
const _bz = new Vector3();
// contact-fit scratch (build time only, but the no-allocation rule holds anyway)
const _fitInv = new Matrix();
const _fitP = new Vector3();
const _fitD = new Vector3();
const _fitAxis = new Vector3();
const _fitAx0 = new Vector3();

/** サブツリーのワールド行列を親→子の順で強制再計算する (build 時の測定用)。 */
function updateSubtree(node) {
  node.computeWorldMatrix(true);
  for (const c of node.getChildTransformNodes(true)) updateSubtree(c);
}

/**
 * Orient a bone whose geometry runs along its local -Z so that -Z points along
 * `dir`, with local +Y rolled toward `up`。lookAt を使わない理由は Three 版と
 * 同じ (lookAt は +Z を向ける & world 空間解釈でリグローカルには使えない)。
 */
function aimBone(quat, dir, up) {
  _bz.copyFrom(dir).scaleInPlace(-1).normalize(); // local +Z is opposite the bone
  _by.copyFrom(up);
  _bz.scaleAndAddToRef(-Vector3.Dot(_by, _bz), _by);
  if (_by.lengthSquared() < 1e-9) {
    _by.set(0, 1, 0);
    _bz.scaleAndAddToRef(-_bz.y, _by);
    if (_by.lengthSquared() < 1e-9) {
      _by.set(1, 0, 0);
      _bz.scaleAndAddToRef(-_bz.x, _by);
    }
  }
  _by.normalize();
  Vector3.CrossToRef(_by, _bz, _bx);
  _bx.normalize();
  return Quaternion.RotationQuaternionFromAxisToRef(_bx, _by, _bz, quat);
}

/**
 * One arm: shoulder -> upper -> fore -> hand, solved from the hand target.
 * All positions are expressed in the arm root's parent space (the viewmodel
 * rig's space), which is what makes the maths trivial.
 */
export class Arm {
  constructor(side, materials, opts = {}) {
    this.side = side; // -1 left, +1 right
    this.scene = opts.scene;
    this.scale = opts.scale ?? 1;
    this.l1 = (opts.upper ?? L_UPPER) * this.scale;
    this.l2 = (opts.fore ?? L_FORE) * this.scale;
    this._mats = materials;

    this.root = new TransformNode(side < 0 ? 'arm-left' : 'arm-right', this.scene);

    this.shoulder = new Vector3(
      side * (opts.shoulderX ?? 0.19),
      opts.shoulderY ?? -0.19,
      opts.shoulderZ ?? 0.12
    );
    /**
     * Elbow swing direction, in the ARM ROOT's space — hand 空間で表すと支え手が
     * 掌上向きのとき肘が空へ跳ね上がる (Three 版の教訓)。肘は常に下・外側。
     */
    this.pole = new Vector3(side * 0.46, -0.86, 0.22).normalize();

    // Bones. Geometry extends along -Z from each joint.
    // 袖の径 68→48 mm は「太い無地のチューブ」批評への実測回答 (Three 版参照)。
    this.upper = buildSleeve(this.scene, materials.sleeve, this.l1, 0.044 * this.scale, 0.036 * this.scale, {
      folds: 5,
      elbowPad: true,
    });
    this.fore = buildSleeve(this.scene, materials.sleeve, this.l2, 0.034 * this.scale, 0.024 * this.scale, {
      folds: 7,
      cuff: true,
    });
    this.upperPivot = new TransformNode('upper-pivot', this.scene);
    this.forePivot = new TransformNode('fore-pivot', this.scene);
    this.upperPivot.rotationQuaternion = new Quaternion();
    this.forePivot.rotationQuaternion = new Quaternion();
    this.upper.parent = this.upperPivot;
    this.fore.parent = this.forePivot;
    this.upperPivot.parent = this.root;
    this.forePivot.parent = this.root;

    // Hand.
    this.hand = new TransformNode(side < 0 ? 'hand-left' : 'hand-right', this.scene);
    this.hand.rotationQuaternion = new Quaternion();
    this.hand.parent = this.root;
    this.handInner = new TransformNode('hand-inner', this.scene);
    /**
     * CHIRALITY: 作ってあるメッシュは左手なので、**右腕側**をミラーする
     * (Three 版のコメント参照 — 逆にすると引き金指がグリップ後下に出る)。
     * 負スケール下の巻き順反転は、武器マテリアルが両面描画なので問題にならない。
     */
    this.handInner.scaling.x = side < 0 ? 1 : -1;
    this.handInner.parent = this.hand;
    this.glove = buildGlove(this.scene, materials, { scale: this.scale });
    this.glove.parent = this.handInner;

    // Fingers: index is separate so it can work the trigger.
    const fingerSpecs = [
      { x: 0.0298, len: [0.045, 0.028, 0.022], r: [0.0102, 0.0096, 0.0086, 0.0062] }, // index
      { x: 0.0102, len: [0.049, 0.031, 0.023], r: [0.0104, 0.0098, 0.0088, 0.0064] },
      { x: -0.0104, len: [0.046, 0.029, 0.022], r: [0.01, 0.0094, 0.0084, 0.006] },
      { x: -0.0298, len: [0.038, 0.024, 0.02], r: [0.0092, 0.0086, 0.0078, 0.0056] },
    ];
    this.fingers = [];
    this._segRadius = fingerSpecs.map((s) => s.r.map((v) => v * this.scale));
    this._segLength = fingerSpecs.map((s) => s.len.map((v) => v * this.scale));
    for (let i = 0; i < 4; i++) {
      const sp = fingerSpecs[i];
      const f = buildFinger(this.scene, materials, {
        lengths: sp.len.map((v) => v * this.scale),
        radii: sp.r.map((v) => v * this.scale),
        curl: [0, 0, 0],
      });
      // MCP 関節は掌側 −6 mm (中心線に置くと掌を密着させても指が 8-14 mm 浮く)。
      f.root.position.set(sp.x * this.scale, -0.006 * this.scale, -0.096 * this.scale);
      f.root.rotation.y = -sp.x * 2.2; // fingers fan out very slightly
      f.root.parent = this.glove;
      this.fingers.push(f);
    }
    this.thumb = buildThumb(this.scene, materials, this.scale, THUMB);
    this.thumb.root.position.set(0.037 * this.scale, -0.009 * this.scale, -0.04 * this.scale);
    // Three 'XYZ' Euler で作られた姿勢なので必ず setEulerXYZ を通す。
    this._thumbEuler = [0.2, -0.95, -0.5];
    setEulerXYZ(this.thumb.root, 0.2, -0.95, -0.5);
    this.thumb.root.parent = this.glove;

    /** Per-weapon pose overrides, written by `fitToCylinder`. */
    this.poses = {};

    this.setPose(opts.pose ?? 'wrap');
  }

  /**
   * BUILD-TIME CONTACT SOLVE: clamp every fingertip onto a cylinder.
   * 解析でなく実トランスフォーム連鎖の測定でやる理由は Three 版の長注どおり
   * (0.88 Y スケール・掌側オフセット・ファン回転で解析解は 8-14 mm 外れる)。
   *
   * @param {Vector3}  handPos    wrist target, arm-root space
   * @param {Quaternion} handQuat wrist orientation
   * @param {number[]} axisPoint  a point on the cylinder axis, arm-root space
   * @param {number[]} axisDir    the cylinder axis direction
   * @param {number}   radius     cylinder radius
   * @param {object}   opts       { clearance, poseName }
   * @returns {Vector3[]}         contact points, arm-root space
   */
  fitToCylinder(handPos, handQuat, axisPoint, axisDir, radius, opts = {}) {
    const clearance = opts.clearance ?? 0.001;
    const poseName = opts.poseName ?? this.pose;
    const base = this.poses[poseName] ?? HAND_POSES[poseName] ?? HAND_POSES.clamp;

    this.hand.position.copyFrom(handPos);
    this.hand.rotationQuaternion.copyFrom(handQuat);
    updateSubtree(this.root);
    this.root.getWorldMatrix().invertToRef(_fitInv);
    _fitAxis.set(axisDir[0], axisDir[1], axisDir[2]).normalize();
    const ax0 = _fitAx0.set(axisPoint[0], axisPoint[1], axisPoint[2]);

    /** Signed distance from a joint-local point to the cylinder surface. */
    const gapAt = (joint, lx, ly, lz, out) => {
      joint.computeWorldMatrix(true);
      _fitP.set(lx, ly, lz);
      Vector3.TransformCoordinatesToRef(_fitP, joint.getWorldMatrix(), _fitP);
      Vector3.TransformCoordinatesToRef(_fitP, _fitInv, _fitP);
      if (out) out.copyFrom(_fitP);
      _fitD.copyFrom(_fitP).subtractInPlace(ax0);
      _fitAxis.scaleAndAddToRef(-Vector3.Dot(_fitD, _fitAxis), _fitD);
      return _fitD.length() - radius;
    };

    /** 走査で曲げ角を求める (単調でないので二分探索は不可 — Three 版どおり)。 */
    const fitJoint = (joint, local, lo, hi, standoff = 0) => {
      let best = joint.rotation.x;
      let bestCost = Infinity;
      for (let i = 0; i <= 48; i++) {
        const a = lo + ((hi - lo) * i) / 48;
        joint.rotation.x = a;
        const g = gapAt(joint, local[0], local[1], local[2]) - standoff;
        const cost = Math.abs(g - clearance * 0.5) + (g < -0.0015 ? (-g - 0.0015) * 8 : 0);
        if (cost < bestCost) {
          bestCost = cost;
          best = a;
        }
      }
      joint.rotation.x = best;
      return best;
    };

    // Wrap all three joints, PROXIMAL FIRST (Three 版の長注参照)。
    const fingers = [];
    const contacts = [];
    for (let i = 0; i < 4; i++) {
      const f = this.fingers[i];
      const curl = base.fingers[i].slice();
      for (let j = 0; j < 3; j++) f.joints[j].rotation.x = -curl[j];
      const rr = this._segRadius?.[i] ?? [0.01, 0.0094, 0.0084, 0.006];
      const ll = this._segLength?.[i] ?? [0.046, 0.029, 0.022];
      for (let j = 0; j < 2; j++) {
        const a = fitJoint(f.joints[j], [0, 0, -ll[j]], -1.75, -0.05, rr[j + 1] * 0.92);
        curl[j] = -a;
      }
      const local = [0, -rr[3] * 1.05, -ll[2] * 0.5];
      const a2 = fitJoint(f.joints[2], local, -1.95, -0.1, 0);
      curl[2] = -a2;
      fingers.push(curl);
      const p = new Vector3();
      gapAt(f.joints[2], local[0], local[1], local[2], p);
      contacts.push(p);
    }

    // ---- thumb: 付け根 (Y 外転 + Z) も走査してから 2 関節をフィット ----
    const thumbBase = (base.thumbBase ?? [0, 0, 0]).slice();
    const thumb = (base.thumb ?? [0.3, 0.24]).slice();
    setEulerXYZ(this.thumb.root, thumbBase[0], thumbBase[1], thumbBase[2]);
    this.thumb.joints[0].rotation.x = -thumb[0];
    this.thumb.joints[1].rotation.x = -thumb[1];
    const tr = THUMB.r2 * this.scale;
    const tlen = THUMB.l1 * this.scale;
    const tLocal = [0, -tr * 1.05, -tlen * 0.55];
    {
      this.thumb.joints[0].rotation.x = -0.55;
      this.thumb.joints[1].rotation.x = -0.45;
      const y0 = thumbBase[1];
      const z0 = thumbBase[2];
      let bestY = y0;
      let bestZ = z0;
      let bestCost = Infinity;
      for (let i = 0; i <= 20; i++) {
        const yy = y0 - 1.3 + (2.6 * i) / 20;
        for (let k = 0; k <= 14; k++) {
          const zz = z0 - 0.9 + (1.8 * k) / 14;
          setEulerXYZ(this.thumb.root, thumbBase[0], yy, zz);
          const g = gapAt(this.thumb.joints[1], tLocal[0], tLocal[1], tLocal[2]);
          const cost =
            Math.abs(g - clearance) +
            (g < -0.002 ? (-g - 0.002) * 10 : 0) +
            (Math.abs(yy - y0) + Math.abs(zz - z0)) * 0.0009;
          if (cost < bestCost) {
            bestCost = cost;
            bestY = yy;
            bestZ = zz;
          }
        }
      }
      setEulerXYZ(this.thumb.root, thumbBase[0], bestY, bestZ);
      thumbBase[1] = bestY;
      thumbBase[2] = bestZ;
    }
    const a0 = fitJoint(
      this.thumb.joints[0],
      [0, 0, -THUMB.l0 * this.scale],
      -1.45,
      -0.02,
      THUMB.r1 * this.scale
    );
    thumb[0] = -a0;
    const a1 = fitJoint(this.thumb.joints[1], tLocal, -1.6, -0.05, 0);
    thumb[1] = -a1;
    const tp = new Vector3();
    gapAt(this.thumb.joints[1], tLocal[0], tLocal[1], tLocal[2], tp);
    contacts.push(tp);

    this.poses[poseName] = { fingers, thumb, thumbBase };
    this.pose = poseName;
    return contacts;
  }

  /** Static finger poses. The trigger finger is driven separately. */
  setPose(name) {
    const P = this.poses?.[name] ?? HAND_POSES[name] ?? HAND_POSES.wrap;
    for (let i = 0; i < 4; i++) {
      const curl = P.fingers[i];
      for (let j = 0; j < 3; j++) this.fingers[i].joints[j].rotation.x = -curl[j];
    }
    this.thumb.joints[0].rotation.x = -P.thumb[0];
    this.thumb.joints[1].rotation.x = -P.thumb[1];
    if (P.thumbBase) setEulerXYZ(this.thumb.root, P.thumbBase[0], P.thumbBase[1], P.thumbBase[2]);
    this.pose = name;
    return this;
  }

  /** Trigger-finger curl, 0 = off the trigger, 1 = fully pressed. */
  setTrigger(t) {
    const f = this.fingers[0];
    f.joints[0].rotation.x = -(0.55 + t * 0.3);
    f.joints[1].rotation.x = -(0.72 + t * 0.42);
    f.joints[2].rotation.x = -(0.34 + t * 0.3);
  }

  /**
   * Solve the two-bone chain so the hand lands exactly on `targetPos` with
   * orientation `targetQuat`, elbow swung toward the pole.
   */
  solve(targetPos, targetQuat) {
    this.hand.position.copyFrom(targetPos);
    this.hand.rotationQuaternion.copyFrom(targetQuat);

    _t.copyFrom(targetPos).subtractInPlace(this.shoulder);
    let d = _t.length();
    const maxD = (this.l1 + this.l2) * 0.995;
    const minD = Math.abs(this.l1 - this.l2) * 1.05 + 1e-4;
    if (d > maxD) {
      _t.scaleInPlace(maxD / d);
      d = maxD;
    } else if (d < minD) {
      if (d < 1e-5) _t.set(0, 0, -minD);
      else _t.scaleInPlace(minD / d);
      d = minD;
    }
    _dir.copyFrom(_t).scaleInPlace(1 / d);

    // Circle of possible elbow positions; pick the point toward the pole.
    const a = (this.l1 * this.l1 - this.l2 * this.l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, this.l1 * this.l1 - a * a));
    _pole.copyFrom(this.pole);
    _perp.copyFrom(_pole);
    _dir.scaleAndAddToRef(-Vector3.Dot(_pole, _dir), _perp);
    if (_perp.lengthSquared() < 1e-8) {
      _perp.set(this.side, -1, 0);
      _dir.scaleAndAddToRef(-Vector3.Dot(_perp, _dir), _perp);
    }
    _perp.normalize();
    _elbow.copyFrom(this.shoulder);
    _dir.scaleAndAddToRef(a, _elbow);
    _perp.scaleAndAddToRef(h, _elbow);

    // Upper arm: shoulder -> elbow, elbow pad (+Y) on the pole side.
    this.upperPivot.position.copyFrom(this.shoulder);
    _hp.copyFrom(_elbow).subtractInPlace(this.shoulder);
    if (_hp.lengthSquared() > 1e-12) aimBone(this.upperPivot.rotationQuaternion, _hp, _perp);

    // Forearm: elbow -> wrist, rolled with the back of the hand.
    this.forePivot.position.copyFrom(_elbow);
    _up.set(0, 1, 0);
    _up.rotateByQuaternionToRef(targetQuat, _up);
    _hp.copyFrom(targetPos).subtractInPlace(_elbow);
    if (_hp.lengthSquared() > 1e-12) aimBone(this.forePivot.rotationQuaternion, _hp, _up);
    return this;
  }

  dispose() {
    this.root.dispose();
  }
}

/**
 * Finger curls per pose, in radians per joint (proximal, middle, distal).
 * 値と導出の経緯は Three 版のコメントを圧縮して要点のみ残す:
 *  - grip: 3 本の下指がグリップを ~180° 巻く。index は setTrigger が駆動
 *  - clamp: 47 mm ハンドガードに対して関節ごとに解いた値 (中間関節が最大)
 *  - thumbBase は Three 'XYZ' Euler — setEulerXYZ を通して適用される
 */
export const HAND_POSES = {
  /** Firing grip on a pistol grip. */
  grip: {
    fingers: [
      [0.55, 0.72, 0.34],
      [1.15, 1.2, 0.62],
      [1.2, 1.25, 0.65],
      [1.22, 1.28, 0.66],
    ],
    thumb: [0.5, 0.34],
    thumbBase: [0.15, -1.02, -0.62],
  },
  /** Support hand wrapped around a handguard. */
  wrap: {
    fingers: [
      [1.18, 1.05, 0.45],
      [1.26, 1.12, 0.5],
      [1.3, 1.16, 0.55],
      [1.34, 1.2, 0.6],
    ],
    thumb: [0.42, 0.3],
    thumbBase: [0.1, -1.15, -0.35],
  },
  /** C-clamp on a handguard (per-joint solve against the rifle's 47 mm tube). */
  clamp: {
    fingers: [
      [0.612, 1.059, 0.797],
      [0.731, 1.286, 0.863],
      [0.73, 1.268, 0.808],
      [0.601, 1.105, 0.684],
    ],
    thumb: [0.3, 0.24],
    thumbBase: [0.04, 0.76, -0.05],
  },
  /** Two-handed pistol grip: support hand cups the shooting hand. */
  cup: {
    fingers: [
      [1.05, 0.95, 0.4],
      [1.12, 1.0, 0.44],
      [1.16, 1.04, 0.48],
      [1.2, 1.08, 0.52],
    ],
    thumb: [0.28, 0.2],
    thumbBase: [0.0, -1.25, -0.2],
  },
  /** Open hand: mag grab, charging handle, inspect. */
  open: {
    fingers: [
      [0.35, 0.28, 0.14],
      [0.32, 0.26, 0.12],
      [0.34, 0.28, 0.14],
      [0.4, 0.32, 0.16],
    ],
    thumb: [0.12, 0.1],
    thumbBase: [0.1, -0.8, -0.35],
  },
  /** Pinch: holding the charging handle or a magazine by its spine. */
  pinch: {
    fingers: [
      [0.95, 0.85, 0.55],
      [1.0, 0.9, 0.6],
      [0.7, 0.6, 0.35],
      [0.6, 0.5, 0.3],
    ],
    thumb: [0.62, 0.55],
    thumbBase: [0.25, -0.75, -0.7],
  },
};
