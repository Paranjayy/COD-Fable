import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { Buffer } from '@babylonjs/core/Buffers/buffer.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector.js';

import { WGSL_DECAL_VERT, WGSL_DECAL_FRAG } from './wgsl/decal.js';

/** 1 デカールあたりの float 数。4 x vec4。 */
const STRIDE = 16;
const O_POS = 0; // x, y, z, radius
const O_NRM = 4; // nx, ny, nz, rotation
const O_MSC = 8; // tile, birth, 1/life, alpha
const O_COL = 12; // r, g, b, unused

let _registered = false;

/**
 * デカールのリングバッファ。
 *
 * パーティクルと同じ「ステートレス + リングバッファ + インターリーブ 1 本」の構成。
 * 寿命の管理はシェーダ側 (birth と 1/life から age を求める) なので CPU の更新
 * ループは存在しない。
 *
 * 容量を使い切ると **古いものから上書き**される。config.q.decalBudget が上限。
 * 弾痕が消えるのが早いと感じたら予算を上げること (寿命を延ばすのではなく)。
 */
export class DecalLayer {
  constructor({ capacity, atlas, cols, scene }) {
    if (!_registered) {
      ShaderStore.ShadersStoreWGSL['owDecalVertexShader'] = WGSL_DECAL_VERT;
      ShaderStore.ShadersStoreWGSL['owDecalFragmentShader'] = WGSL_DECAL_FRAG;
      _registered = true;
    }

    this.capacity = Math.max(16, capacity | 0);
    this.cursor = 0;
    this.highWater = 0;
    this._wrapped = false;
    this.expireAt = -1;
    this.array = new Float32Array(this.capacity * STRIDE);

    const mesh = new Mesh('fx-decals', scene);
    const vd = new VertexData();
    vd.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
    vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    vd.indices = [0, 1, 2, 0, 2, 3];
    vd.applyToMesh(mesh, false);

    const engine = scene.getEngine();
    this.buffer = new Buffer(engine, this.array, true, STRIDE, false, true);
    const bind = (kind, offset) =>
      mesh.setVerticesBuffer(this.buffer.createVertexBuffer(kind, offset, 4, STRIDE, true));
    bind('aPos', O_POS);
    bind('aNrm', O_NRM);
    bind('aMisc', O_MSC);
    bind('aCol', O_COL);

    mesh.forcedInstanceCount = 0;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { owNoShadow: true, owNoCollision: true, owFx: true };
    // 不透明の後、パーティクルより先に描く。壁の弾痕の上に土煙が乗る順序。
    mesh.alphaIndex = 6;
    this.mesh = mesh;

    const mat = new ShaderMaterial(
      'fx-decals',
      scene,
      { vertex: 'owDecal', fragment: 'owDecal' },
      {
        attributes: ['position', 'uv', 'aPos', 'aNrm', 'aMisc', 'aCol'],
        uniforms: ['viewProjection', 'uTime', 'uAtlas', 'uSunDir', 'uSunCol', 'uAmb'],
        samplers: ['uSprite'],
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: true,
      }
    );
    mat.backFaceCulling = false;
    /** 深度は書かない。書くと後から貼ったデカールが先のものを消す。 */
    mat.disableDepthWrite = true;
    mat.alphaMode = Constants.ALPHA_COMBINE;
    mat.setTexture('uSprite', atlas);
    mat.setVector4('uAtlas', new Vector4(cols, 1 / cols, 0, 0));
    mat.setVector3('uSunDir', new Vector3(0, 1, 0));
    mat.setVector3('uSunCol', new Vector3(1, 0.95, 0.86));
    mat.setVector3('uAmb', new Vector3(0.3, 0.34, 0.4));
    mat.setFloat('uTime', 0);
    this.material = mat;
    mesh.material = mat;
    mesh.setEnabled(false);

    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;
  }

  /**
   * デカールを 1 枚貼る。
   *
   * @param point  world 座標の貼り付け点
   * @param normal 面の法線 (正規化済み)
   * @param o      { tile, size, life, alpha, rot, r, g, b }
   */
  add(point, normal, o, now) {
    const i = this.cursor;
    this.cursor = i + 1;
    if (this.cursor >= this.capacity) {
      this.cursor = 0;
      this._wrapped = true;
    }
    if (i + 1 > this.highWater) this.highWater = i + 1;

    const a = this.array;
    const b = i * STRIDE;
    const life = Math.max(0.5, o.life ?? 60);

    a[b + O_POS] = point.x;
    a[b + O_POS + 1] = point.y;
    a[b + O_POS + 2] = point.z;
    a[b + O_POS + 3] = o.size ?? 0.06;

    a[b + O_NRM] = normal.x;
    a[b + O_NRM + 1] = normal.y;
    a[b + O_NRM + 2] = normal.z;
    a[b + O_NRM + 3] = o.rot ?? 0;

    a[b + O_MSC] = o.tile ?? 0;
    a[b + O_MSC + 1] = now;
    a[b + O_MSC + 2] = 1 / life;
    a[b + O_MSC + 3] = o.alpha ?? 1;

    a[b + O_COL] = o.r ?? 1;
    a[b + O_COL + 1] = o.g ?? 1;
    a[b + O_COL + 2] = o.b ?? 1;
    a[b + O_COL + 3] = 0;

    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
    const end = now + life;
    if (end > this.expireAt) this.expireAt = end;
    return i;
  }

  flush(now) {
    if (this._dirtyHi >= this._dirtyLo) {
      const lo = this._dirtyLo * STRIDE;
      const hi = (this._dirtyHi + 1) * STRIDE;
      this.buffer.updateDirectly(this.array.subarray(lo, hi), lo);
      this._dirtyLo = Infinity;
      this._dirtyHi = -Infinity;
    }
    this.material.setFloat('uTime', now);
    const count = this._wrapped ? this.capacity : this.highWater;
    this.mesh.forcedInstanceCount = count;
    this.mesh.setEnabled(now < this.expireAt && count > 0);
  }

  setLighting(sunDir, sunCol, amb) {
    this.material.setVector3('uSunDir', sunDir);
    this.material.setVector3('uSunCol', sunCol);
    this.material.setVector3('uAmb', amb);
  }

  dispose() {
    this.mesh.dispose();
    this.material.dispose();
    this.buffer.dispose();
  }
}
