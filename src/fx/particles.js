import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { Buffer } from '@babylonjs/core/Buffers/buffer.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector.js';

import { WGSL_PARTICLE_VERT, WGSL_PARTICLE_FRAG } from './wgsl/particle.js';

/** 1 粒子あたりの float 数。8 x vec4。 */
export const STRIDE = 32;

// インターリーブされたスロットのオフセット
const O_PS = 0; // pos.xyz, size0
const O_VS = 4; // vel.xyz, size1
const O_LF = 8; // birth, 1/life, drag, gravity
const O_RT = 12; // rot0, spin, stretch, sizeCurve
const O_C0 = 16; // colour A rgb, intensity A
const O_C1 = 20; // colour B rgb, intensity B
const O_MS = 24; // tile, softness, alpha, alphaCurve
const O_EX = 28; // turbAmp, turbFreq, seed, flags

/**
 * 再利用される spawn 記述子。
 *
 * **spawn は決してアロケーションしてはならない** (ARCHITECTURE.md Hard rule 5)。
 * 1 発の着弾で数十粒子が出るので、ここで new すると着弾のたびに GC 圧が跳ねる。
 * 呼び出し側は `resetSpawn()` で初期化してからフィールドを埋め、`emit` に渡す。
 */
export const SP = {
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  size0: 0.2, size1: 0.3, sizeCurve: 1,
  life: 1, delay: 0, drag: 1.4, gravity: 0,
  rot: 0, spin: 0,
  /** 速度方向への引き伸ばし。長さ = size * (1 + stretch * speed)。
   *  1 前後が 60Hz の 1 フレーム相当のモーションブラーになる。 */
  stretch: 0,
  r0: 1, g0: 1, b0: 1, i0: 1,
  r1: 1, g1: 1, b1: 1, i1: 0,
  tile: 0, soft: 0.4, alpha: 1, alphaCurve: 1,
  turb: 0, turbFreq: 1, seed: 0, flags: 0,
};

export function resetSpawn() {
  const s = SP;
  s.x = s.y = s.z = 0;
  s.vx = s.vy = s.vz = 0;
  s.size0 = 0.2; s.size1 = 0.3; s.sizeCurve = 1;
  s.life = 1; s.delay = 0; s.drag = 1.4; s.gravity = 0;
  s.rot = 0; s.spin = 0; s.stretch = 0;
  s.r0 = s.g0 = s.b0 = 1; s.i0 = 1;
  s.r1 = s.g1 = s.b1 = 1; s.i1 = 0;
  s.tile = 0; s.soft = 0.4; s.alpha = 1; s.alphaCurve = 1;
  s.turb = 0; s.turbFreq = 1; s.seed = 0; s.flags = 0;
  return s;
}

let _shadersRegistered = false;

function registerShaders() {
  if (_shadersRegistered) return;
  ShaderStore.ShadersStoreWGSL['owParticleVertexShader'] = WGSL_PARTICLE_VERT;
  ShaderStore.ShadersStoreWGSL['owParticleFragmentShader'] = WGSL_PARTICLE_FRAG;
  _shadersRegistered = true;
}

/**
 * 固定容量のリングバッファに載った 1 層ぶんのパーティクル。
 *
 * アロケーションはコンストラクタで 1 回だけ。以降は同じ Float32Array を書き換えて
 * 差分だけ GPU に上げる。
 *
 * ## リングバッファである理由
 *
 * 「寿命が尽きた粒子を詰める」処理を一切しないため。詰めると CPU 側で全粒子を
 * 走査することになり、ステートレス GPU パーティクルの利点が消える。古い粒子は
 * 上書きされるだけで、生きているうちに上書きされたら **それは容量不足のサイン**
 * (config.q.particleBudget を上げるか、レシピの粒子数を減らす)。
 */
export class ParticleLayer {
  /**
   * @param {object} o
   * @param {number} o.capacity   config.q.particleBudget から
   * @param {'additive'|'lit'} o.mode
   * @param {BaseTexture} o.atlas
   * @param {number} o.cols       アトラスの列数
   * @param {Scene} o.scene
   */
  constructor(o) {
    registerShaders();

    this.capacity = Math.max(16, o.capacity | 0);
    this.mode = o.mode;
    this.cursor = 0;
    this.highWater = 0;
    this.expireAt = -1;
    this.spawned = 0;
    this.scene = o.scene;

    this.array = new Float32Array(this.capacity * STRIDE);

    // --- 板ポリ 1 枚 ---------------------------------------------------
    const mesh = new Mesh(`fx-particles-${o.mode}`, o.scene);
    const vd = new VertexData();
    vd.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
    vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    vd.indices = [0, 1, 2, 0, 2, 3];
    vd.applyToMesh(mesh, false);

    // --- インスタンス属性 ----------------------------------------------
    /**
     * 8 本の vec4 属性をすべて **1 本のインターリーブバッファ**から切り出す。
     *
     * 8 本の独立したバッファにすると、1 粒子の書き込みが 8 箇所に散らばって
     * 差分アップロードの範囲が広がる。インターリーブなら 1 粒子 = 連続した
     * 32 float なので、「i 番から j 番まで」の 1 範囲で済む。
     */
    const engine = o.scene.getEngine();
    this.buffer = new Buffer(engine, this.array, true, STRIDE, false, true);
    const bind = (kind, offset) =>
      mesh.setVerticesBuffer(this.buffer.createVertexBuffer(kind, offset, 4, STRIDE, true));
    bind('aPS', O_PS);
    bind('aVS', O_VS);
    bind('aLife', O_LF);
    bind('aRot', O_RT);
    bind('aCol0', O_C0);
    bind('aCol1', O_C1);
    bind('aMisc', O_MS);
    bind('aExtra', O_EX);

    mesh.forcedInstanceCount = 0;
    /**
     * 粒子はシェーダ内でワールド空間に置かれる。メッシュ自体の変換は恒等で、
     * バウンディングボックスも意味を持たない。**カリングされると全部消える**ので
     * 必ず常時アクティブにする。
     */
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    /** 影を落とさない / 物理を持たない印。render と physics が見る。 */
    mesh.metadata = { owNoShadow: true, owNoCollision: true, owFx: true };
    // 半透明は最後に描く。加算はさらに後ろ。
    mesh.renderingGroupId = 0;
    mesh.alphaIndex = o.mode === 'additive' ? 12 : 10;
    this.mesh = mesh;

    // --- マテリアル -----------------------------------------------------
    const additive = o.mode === 'additive';
    const defines = [];
    if (additive) defines.push('#define ADDITIVE');
    else defines.push('#define LIT');

    const mat = new ShaderMaterial(
      `fx-particles-${o.mode}`,
      o.scene,
      { vertex: 'owParticle', fragment: 'owParticle' },
      {
        attributes: ['position', 'uv', 'aPS', 'aVS', 'aLife', 'aRot', 'aCol0', 'aCol1', 'aMisc', 'aExtra'],
        uniforms: ['view', 'projection', 'uTime', 'uAtlas', 'uSunDir', 'uSunCol', 'uAmbTop', 'uAmbBot', 'uUpView', 'uFog'],
        samplers: ['uSprite'],
        defines,
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: true,
      }
    );
    mat.backFaceCulling = false;
    mat.depthFunction = Constants.LESS;
    /**
     * 深度は **書かない**。半透明の粒子が深度を書くと、後ろの粒子が消える。
     * ソートは alphaIndex に任せる。
     */
    mat.disableDepthWrite = true;
    mat.alphaMode = additive ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE;
    mat.setTexture('uSprite', o.atlas);
    mat.setVector4('uAtlas', new Vector4(o.cols, 1 / o.cols, 0, 0));
    mat.setVector3('uSunDir', new Vector3(0, 1, 0));
    mat.setVector3('uSunCol', new Vector3(1, 0.95, 0.86));
    mat.setVector3('uAmbTop', new Vector3(0.35, 0.42, 0.55));
    mat.setVector3('uAmbBot', new Vector3(0.16, 0.14, 0.12));
    mat.setVector3('uUpView', new Vector3(0, 1, 0));
    mat.setVector4('uFog', new Vector4(0.6, 0.65, 0.72, 0));
    mat.setFloat('uTime', 0);
    this.material = mat;
    mesh.material = mat;
    mesh.setEnabled(false);

    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;
    this._wrapped = false;
  }

  /** 生きている粒子がありうる間 true。 */
  get active() {
    return this.mesh.isEnabled();
  }

  /**
   * 粒子を 1 つ書き込む。`s` は共有の {@link SP}。**resetSpawn() の直後に渡すこと**
   * (前の呼び出しの値が漏れる)。
   */
  emit(s, now) {
    const i = this.cursor;
    this.cursor = i + 1;
    if (this.cursor >= this.capacity) {
      this.cursor = 0;
      this._wrapped = true;
    }
    if (i + 1 > this.highWater) this.highWater = i + 1;

    const a = this.array;
    const b = i * STRIDE;
    const life = Math.max(0.016, s.life);
    const birth = now + s.delay;

    a[b + O_PS] = s.x;
    a[b + O_PS + 1] = s.y;
    a[b + O_PS + 2] = s.z;
    a[b + O_PS + 3] = s.size0;

    a[b + O_VS] = s.vx;
    a[b + O_VS + 1] = s.vy;
    a[b + O_VS + 2] = s.vz;
    a[b + O_VS + 3] = s.size1;

    a[b + O_LF] = birth;
    a[b + O_LF + 1] = 1 / life;
    a[b + O_LF + 2] = s.drag;
    a[b + O_LF + 3] = s.gravity;

    a[b + O_RT] = s.rot;
    a[b + O_RT + 1] = s.spin;
    a[b + O_RT + 2] = s.stretch;
    a[b + O_RT + 3] = s.sizeCurve;

    a[b + O_C0] = s.r0;
    a[b + O_C0 + 1] = s.g0;
    a[b + O_C0 + 2] = s.b0;
    a[b + O_C0 + 3] = s.i0;

    a[b + O_C1] = s.r1;
    a[b + O_C1 + 1] = s.g1;
    a[b + O_C1 + 2] = s.b1;
    a[b + O_C1 + 3] = s.i1;

    a[b + O_MS] = s.tile;
    a[b + O_MS + 1] = s.soft;
    a[b + O_MS + 2] = s.alpha;
    a[b + O_MS + 3] = s.alphaCurve;

    a[b + O_EX] = s.turb;
    a[b + O_EX + 1] = s.turbFreq;
    a[b + O_EX + 2] = s.seed;
    a[b + O_EX + 3] = s.flags;

    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
    const end = birth + life;
    if (end > this.expireAt) this.expireAt = end;
    this.spawned++;
    return i;
  }

  /**
   * 差分をアップロードし、毎フレームの uniform を更新する。1 フレームに 1 回呼ぶ。
   *
   * **`uTime` はゲーム内の経過秒**であって performance.now() ではない。実時計を
   * 使うと、キャプチャで boot 時間が変わるだけで粒子の位相が変わり、bit-identical が
   * 壊れる (README に記録された事故と同じ構図)。
   */
  flush(now) {
    if (this._dirtyHi >= this._dirtyLo) {
      /**
       * Babylon の Buffer は「部分更新」に updateDirectly(data, offsetInFloats) を
       * 使う。**第 2 引数は float 単位のオフセット**で、渡すデータは
       * 「そのオフセットから書き込む分だけ」の subarray。全体を渡すと二重にずれる。
       */
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

  /** 太陽と環境光を更新する。lit レイヤだけが使う。 */
  setLighting(sunDirView, sunCol, ambTop, ambBot, upView, fog) {
    const m = this.material;
    m.setVector3('uSunDir', sunDirView);
    m.setVector3('uSunCol', sunCol);
    m.setVector3('uAmbTop', ambTop);
    m.setVector3('uAmbBot', ambBot);
    m.setVector3('uUpView', upView);
    m.setVector4('uFog', fog);
  }

  dispose() {
    this.mesh.dispose();
    this.material.dispose();
    this.buffer.dispose();
  }
}
