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

/**
 * 粒子属性の名前。**WGSL の `attribute` 宣言と 1 対 1 で対応する。**
 * 片方だけ変えると、その属性だけゼロで届いて静かに壊れる。
 *
 * **配列の順序 = インターリーブバッファ内のオフセット順序** (index * 4 float)。
 * 下の O_* 定数と並びを揃えてあるので、追加・入れ替えは両方を同時に直すこと。
 */
const ATTR_KINDS = ['aPS', 'aVS', 'aLife', 'aRot', 'aCol0', 'aCol1', 'aMisc', 'aExtra'];

// インターリーブされたスロットのオフセット (float 単位。ATTR_KINDS と同順)
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


    /**
     * --- ジオメトリ: 1 粒子 = 4 頂点 --------------------------------------
     *
     * 粒子ごとに 4 頂点を持ち、同じ属性値を 4 回書く古典的な方式。
     * インスタンシング機構に依存しないので、Babylon のバージョンや
     * バックエンドの都合で静かに壊れることがない。
     *
     * 代償: 頂点バッファが 4 倍になり (24k 粒子 = 96k 頂点)、emit の書き込みも
     * 4 倍 (1 粒子 128 float)。着弾 1 発で数十粒子なので実測上は問題にならない。
     *
     * なお過去に試したインスタンシング 2 方式 (instanced VertexBuffer /
     * thinInstanceSetBuffer) が「属性ゼロ」「画面真っ黒」で失敗した根本原因は、
     * 下の「頂点バッファは 1 本」のコメントにある **WebGPU の頂点バッファ数上限**
     * だった。方式の問題ではないが、この 4 頂点方式で正しく動いているので戻す
     * 理由はない。
     */
    const mesh = new Mesh(`fx-particles-${o.mode}`, o.scene);
    const N = this.capacity;
    /** 各頂点がクアッドのどの隅か。(-0.5..0.5, -0.5..0.5) と UV を兼ねる。 */
    const corners = new Float32Array(N * 4 * 3);
    const uvs = new Float32Array(N * 4 * 2);
    const indices = new Uint32Array(N * 6);
    const CX = [-0.5, 0.5, 0.5, -0.5];
    const CY = [-0.5, -0.5, 0.5, 0.5];
    const UX = [0, 1, 1, 0];
    const UY = [0, 0, 1, 1];
    for (let p = 0; p < N; p++) {
      for (let v = 0; v < 4; v++) {
        const k = (p * 4 + v) * 3;
        corners[k] = CX[v];
        corners[k + 1] = CY[v];
        corners[k + 2] = 0;
        const u = (p * 4 + v) * 2;
        uvs[u] = UX[v];
        uvs[u + 1] = UY[v];
      }
      const o6 = p * 6;
      const b4 = p * 4;
      indices[o6] = b4;
      indices[o6 + 1] = b4 + 1;
      indices[o6 + 2] = b4 + 2;
      indices[o6 + 3] = b4;
      indices[o6 + 4] = b4 + 2;
      indices[o6 + 5] = b4 + 3;
    }
    const vd = new VertexData();
    vd.positions = corners;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(mesh, true);

    /**
     * 粒子ごとの属性。**頂点ごとに同じ値を 4 回持ち、8 属性を 1 本のバッファに
     * インターリーブする** (1 頂点 = STRIDE=32 float、オフセットは O_* 定数)。
     *
     * ## 頂点バッファは必ず 1 本にまとめること (このファイル最大の罠)
     *
     * WebGPU の頂点バッファスロット上限は **8 本** (maxVertexBuffers の既定値)。
     * 以前は属性ごとに `mesh.setVerticesData()` で別バッファを作っており、
     * position + uv + 8 属性 = **10 本**で上限を超えていた。このとき何が起きるか:
     *
     *   - CreateRenderPipeline が「Vertex buffer count (10) exceeds the maximum
     *     number of vertex buffers (8)」で失敗する
     *   - 不正なパイプラインを 1 度でも SetPipeline すると、そのフレームの
     *     **コマンドバッファ全体が invalid になり Queue.Submit ごと捨てられる**
     *   - 結果、粒子を 1 つ出しただけで **フレーム全体が真っ黒**になる
     *   - しかもこの検証エラーは console に **error ではなく warning** として
     *     届く (Babylon が uncaptured error を Logger.Warn で流す)。
     *     「console にエラーが無い = GPU は正常」と判断してはならない
     *
     * 過去に「インスタンス属性が全てゼロで届く」「thin instance でシーン全体が
     * 消える」と見えていた症状もすべてこれが原因だった (未使用属性が effect から
     * 削られてバッファ数が 8 以下に収まったときだけ描けていた)。
     *
     * Babylon の WebGPU 実装は「同一の GPU バッファを参照し、effect の属性順で
     * **連続している**属性」を 1 つの GPUVertexBufferLayout にまとめる
     * (webgpuCacheRenderPipeline._getVertexInputDescriptor)。ただし各属性が
     * `offset + サイズ <= stride` を満たすことが条件。ここでは 8 x vec4 を
     * stride 128 byte に詰めるので条件を満たし、position + uv + 本バッファ =
     * **3 スロット**に収まる。属性の宣言順 (ShaderMaterial の attributes と WGSL)
     * を ATTR_KINDS と揃えておくこと — 順序が飛び飛びになるとまとめが効かず
     * スロット数が増える。
     *
     * 副次効果として、flush のアップロードも 8 回 → 1 回になる。
     */
    this.data = new Float32Array(N * 4 * STRIDE);
    this._buffer = new Buffer(o.scene.getEngine(), this.data, true, STRIDE);
    for (let a = 0; a < ATTR_KINDS.length; a++) {
      // offset / stride は float 単位 (useBytes=false)。サイズは vec4f なので 4。
      mesh.setVerticesBuffer(this._buffer.createVertexBuffer(ATTR_KINDS[a], a * 4, 4, STRIDE), false);
    }

    /**
     * 粒子はシェーダ内でワールド空間に置かれる。メッシュ自体の変換は恒等で、
     * バウンディングボックスも意味を持たない。**カリングされると全部消える**ので
     * 必ず常時アクティブにする。
     */
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    /**
     * **doNotSyncBoundingInfo は使わない。**
     *
     * 半透明メッシュは bounding sphere の中心までの距離でソートされる。同期を
     * 切ると距離が不定になり、ソートの比較関数が壊れて **フレーム全体が描画
     * されなくなる** (エラーもワーニングも出ない)。
     *
     * 代わりに「巨大な固定の bounding box」を与える。粒子はシェーダ内で
     * ワールド空間に置かれるためメッシュのバウンディングは意味を持たないが、
     * ソートが成立する有限の値であることが重要。
     */
    mesh.buildBoundingInfo(new Vector3(-1e4, -1e4, -1e4), new Vector3(1e4, 1e4, 1e4));
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

    const life = Math.max(0.016, s.life);
    const birth = now + s.delay;
    const D = this.data;
    const invLife = 1 / life;

    // 4 頂点すべてに同じ値を書く。頂点シェーダは corner (position.xy) だけを
    // 頂点ごとに変え、それ以外はこの値を共有する。
    for (let v = 0; v < 4; v++) {
      const b = (i * 4 + v) * STRIDE;
      D[b + O_PS] = s.x;      D[b + O_PS + 1] = s.y;        D[b + O_PS + 2] = s.z;       D[b + O_PS + 3] = s.size0;
      D[b + O_VS] = s.vx;     D[b + O_VS + 1] = s.vy;       D[b + O_VS + 2] = s.vz;      D[b + O_VS + 3] = s.size1;
      D[b + O_LF] = birth;    D[b + O_LF + 1] = invLife;    D[b + O_LF + 2] = s.drag;    D[b + O_LF + 3] = s.gravity;
      D[b + O_RT] = s.rot;    D[b + O_RT + 1] = s.spin;     D[b + O_RT + 2] = s.stretch; D[b + O_RT + 3] = s.sizeCurve;
      D[b + O_C0] = s.r0;     D[b + O_C0 + 1] = s.g0;       D[b + O_C0 + 2] = s.b0;      D[b + O_C0 + 3] = s.i0;
      D[b + O_C1] = s.r1;     D[b + O_C1 + 1] = s.g1;       D[b + O_C1 + 2] = s.b1;      D[b + O_C1 + 3] = s.i1;
      D[b + O_MS] = s.tile;   D[b + O_MS + 1] = s.soft;     D[b + O_MS + 2] = s.alpha;   D[b + O_MS + 3] = s.alphaCurve;
      D[b + O_EX] = s.turb;   D[b + O_EX + 1] = s.turbFreq; D[b + O_EX + 2] = s.seed;    D[b + O_EX + 3] = s.flags;
    }

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
      // インターリーブバッファを丸ごと再アップロードする (1 本なので 1 回)。
      // emit があったフレームだけなので許容範囲。
      this._buffer.update(this.data);
      this._dirtyLo = Infinity;
      this._dirtyHi = -Infinity;
    }
    this.material.setFloat('uTime', now);
    const count = this._wrapped ? this.capacity : this.highWater;
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
    // createVertexBuffer で切り出した VertexBuffer は共有バッファを所有しない
    // (takeBufferOwnership=false) ので、大本の Buffer はここで自分で捨てる。
    this._buffer.dispose();
  }
}
