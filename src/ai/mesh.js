/**
 * AI — Babylon 側のメッシュ / スケルトン生成と、CPU 姿勢の書き写し。
 *
 * 役割分担 (Babylon 移植後の構図):
 *   - rig.js / animator.js は **CPU 側の math3.Bone 階層**に対して姿勢を書く
 *     (IK・クリップブレンドは Three 版から無改変)。
 *   - このモジュールがビジュアル変種のジオメトリを Babylon Mesh 化し、
 *     アクターごとの Babylon Skeleton を作り、毎フレーム CPU ボーンの
 *     ローカル行列を Babylon Bone に写す (`syncSkeleton`)。
 *
 * ## 行列レイアウトについて (このファイル全体の前提)
 *
 * math3.Matrix4.elements (Three の列優先) と Babylon Matrix の内部バッファは
 * **同じメモリレイアウト** (translation が [12..14])。したがって
 * `Matrix.FromArrayToRef(shim.elements, 0, babylonMatrix)` で無変換コピーできる。
 * ここを「転置が要るのでは」と直したくなったら math3.js 冒頭を読むこと —
 * 転置すると全身が捻れて壊れる。
 */

import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { Skeleton } from '@babylonjs/core/Bones/skeleton.js';
import { Bone } from '@babylonjs/core/Bones/bone.js';
import { Matrix, Vector3 as BVector3 } from '@babylonjs/core/Maths/math.vector.js';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo.js';

import { Matrix4 } from './math3.js';

/**
 * buildSoldier() の生ジオメトリレコード + マテリアル配列から、共有テンプレート
 * Mesh を作る。テンプレートは setEnabled(false) で描画されず、各エージェントは
 * clone() でジオメトリを共有したまま自分のインスタンスを持つ。
 */
export function buildVariantTemplate(scene, name, built) {
  const g = built.geometry;
  const mesh = new Mesh(`ai_tmpl_${name}`, scene);

  const vd = new VertexData();
  vd.positions = g.positions;
  vd.normals = g.normals;
  vd.uvs = g.uvs;
  // Babylon の ColorKind は RGBA (4 成分)。builder は RGB で焼くのでここで詰め直す。
  const n = g.positions.length / 3;
  const rgba = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = g.colors[i * 3];
    rgba[i * 4 + 1] = g.colors[i * 3 + 1];
    rgba[i * 4 + 2] = g.colors[i * 3 + 2];
    rgba[i * 4 + 3] = 1;
  }
  vd.colors = rgba;
  // スキニング: 1 頂点 4 影響 (builder の _bind が 4 本に絞っている =
  // Babylon の既定 numBoneInfluencers と一致。超えると MatricesIndicesExtra が要る)
  //
  // 罠: builder は skinIndex を Uint16Array で持つが、**Babylon には Float32 で
  // 渡す**。VertexData は配列の型から頂点フォーマットを決めるため、Uint16 の
  // ままだと WebGPU 側で uint16x4 として宣言され、シェーダの想定 (f32) と
  // 食い違ってボーン索引がゴミになる = メッシュが画面全体に爆発する。
  const mi = new Float32Array(g.matricesIndices.length);
  for (let i = 0; i < mi.length; i++) mi[i] = g.matricesIndices[i];
  vd.matricesIndices = mi;
  vd.matricesWeights = g.matricesWeights;
  vd.indices = g.indices;
  vd.applyToMesh(mesh, false);

  // ---- マテリアルグループ → SubMesh ---------------------------------
  // Three の geometry.addGroup 相当。groups は index 単位の {start, count}。
  const multi = new MultiMaterial(`ai_mm_${name}`, scene);
  multi.subMaterials = built.materials;
  mesh.material = multi;
  mesh.subMeshes = [];
  const matIndex = (m) => built.materialNames.indexOf(m);
  for (const grp of g.groups) {
    // SubMesh(materialIndex, verticesStart, verticesCount, indexStart, indexCount, mesh)
    new SubMesh(matIndex(grp.mat), 0, n, grp.start, grp.count, mesh);
  }

  // ---- バウンディング ------------------------------------------------
  // バインドポーズの AABB を 1.45 倍に膨らませる (アニメーション中の姿勢が
  // バインド境界の外へ出るため)。フラスタムカリングはこれを見る。
  applyInflatedBounds(mesh, g.boundingBox);

  mesh.receiveShadows = true;
  mesh.isPickable = false;
  mesh.setEnabled(false);
  return mesh;
}

/** バインド AABB を中心固定で 1.45 倍して BoundingInfo を張り直す。 */
export function applyInflatedBounds(mesh, box) {
  const cx = (box.min[0] + box.max[0]) * 0.5;
  const cy = (box.min[1] + box.max[1]) * 0.5;
  const cz = (box.min[2] + box.max[2]) * 0.5;
  const k = 1.45;
  const min = new BVector3(
    cx + (box.min[0] - cx) * k,
    cy + (box.min[1] - cy) * k,
    cz + (box.min[2] - cz) * k
  );
  const max = new BVector3(
    cx + (box.max[0] - cx) * k,
    cy + (box.max[1] - cy) * k,
    cz + (box.max[2] - cz) * k
  );
  mesh.setBoundingInfo(new BoundingInfo(min, max));
}

/**
 * アクター 1 体ぶんの Babylon Skeleton。バインドローカル行列は rig の
 * localPos/localQuat から合成する。Bone は localMatrix をそのまま bind 行列
 * として採用するので (bone.pure.js の constructor 参照)、逆バインドは
 * Babylon 側が自動で持つ。
 */
export function createBabylonSkeleton(scene, rig, name) {
  const skeleton = new Skeleton(name, name, scene);
  const bBones = [];
  const tmp = new Matrix4();
  for (let i = 0; i < rig.count; i++) {
    tmp.compose(rig.localPos[i], rig.localQuat[i], UNIT);
    const local = Matrix.FromArray(tmp.elements);
    const parent = rig.parent[i] >= 0 ? bBones[rig.parent[i]] : null;
    bBones.push(new Bone(rig.names[i], skeleton, parent, local));
  }
  return { skeleton, bBones };
}

const UNIT = { x: 1, y: 1, z: 1 };

/**
 * CPU ボーン (math3.Bone, animator が更新済み) のローカル行列を Babylon の
 * Bone にコピーする。毎フレーム呼ばれる — アロケーションなし。
 *
 * animator は書いた後に必ず updateMatrix() 済みなので、shim 側の matrix を
 * そのまま信用してよい (position/quaternion からの再合成はしない)。
 */
export function syncSkeleton(shimBones, bBones, skeleton) {
  for (let i = 0; i < shimBones.length; i++) {
    Matrix.FromArrayToRef(shimBones[i].matrix.elements, 0, bBones[i].getLocalMatrix());
  }
  // 全ボーンを書いてから 1 回だけ dirty にする (markAsDirty を 25 回呼ばない)
  skeleton._markAsDirty();
}
