/**
 * AI — grounding occlusion under every actor.
 *
 * カスケードシャドウは 1.7 m の人物の落ち影は解像できるが、ブーツ直下の
 * ミリメートル級の空遮蔽は解像できない (2048px / 12m カスケードで 1 テクセル
 * 6mm、スキンメッシュの自己影を止める depth bias がちょうどそれを食う)。
 * 結果は古典的な「足が 1cm 浮いて見える」読みで、落ち影の品質では直らない。
 *
 * そこで各アクターに投影遮蔽スプライトを持たせる: 骨盤下に体幅の楕円 1 枚、
 * 各足下にタイトなローブ 1 枚。
 *
 * 暗くする方法 — ほぼ黒のソース色でのアルファブレンド。代数的には
 * dst*(1-a) + わずかな空色、つまり実質乗算なので、露出やライティングに
 * 依存せず、日なたの砂でも日陰のコンクリでも成立する。加算や不透明デカールの
 * ように床へ灰色のシルエットを描いてしまうことがない。
 *
 * 強度は per-instance ではクアッドの**サイズ**で表現する: 地面を離れた足の
 * 接地パッチは小さく柔らかくなるので、フェードよりスプライトを縮める方が
 * 安上がりで正しい。
 *
 * Babylon 実装: Three 版の InstancedMesh 2 枚を thin instance 2 枚に置き換え。
 * 描画は 2 ドローコールのまま。行列バッファは begin()/addActor()/end() で
 * 毎フレーム詰め直す (プリアロケート済み Float32Array — Hard rule 5)。
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
// 行列合成は math3 (Three 互換) で行う。shim の Matrix4.elements (列優先) は
// Babylon の行列バッファとメモリレイアウトが一致するので、そのまま
// thin instance バッファへ copy できる。Babylon の Quaternion.multiply の
// 積の向きを推測でいじって鏡写しになる事故を避けるための選択。
import { Vector3, Quaternion, Matrix4 } from './math3.js';

/** 放射状の遮蔽スプライト。rgb 白、アルファ = 遮蔽量。 */
function buildTexture(scene, size = 64, power = 3.4) {
  const buf = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const r = Math.min(1, Math.hypot(u, v));
      let a = Math.exp(-r * r * power);
      a *= 1 - r * r * r; // 縁で厳密に 0: 円盤の縁が見えないように
      const i = (y * size + x) * 4;
      buf[i] = 255;
      buf[i + 1] = 255;
      buf[i + 2] = 255;
      buf[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
    }
  }
  const t = RawTexture.CreateRGBATexture(
    buf, size, size, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE
  );
  t.wrapU = Texture.CLAMP_ADDRESSMODE;
  t.wrapV = Texture.CLAMP_ADDRESSMODE;
  t.gammaSpace = false;
  t.hasAlpha = true;
  return t;
}

export class GroundShadows {
  /**
   * @param scene   Babylon Scene
   * @param parent  TransformNode 親 (ai の root)
   * @param actors  想定アクター数 (ハードキャップ)
   */
  constructor(scene, parent, actors = 12) {
    this.capacity = Math.max(4, actors);
    this.scene = scene;
    this.texture = buildTexture(scene, 64, 3.4);
    this.footTexture = buildTexture(scene, 64, 4.6);

    // 純黒ではない: 接地影は「遮られた空」に照らされるので空の青をわずかに残す。
    const mk = (name, tex, opacity) => {
      const m = new StandardMaterial(name, scene);
      m.disableLighting = true;
      m.emissiveColor = new Color3(0.045, 0.05, 0.062);
      m.diffuseColor = new Color3(0, 0, 0);
      m.specularColor = new Color3(0, 0, 0);
      m.opacityTexture = tex; // アルファチャンネルを使う (getAlphaFromRGB 既定 false)
      m.alpha = opacity;
      m.disableDepthWrite = true;
      m.backFaceCulling = false;
      return m;
    };
    this.bodyMat = mk('ai-ground-ao-body', this.texture, 0.62);
    this.footMat = mk('ai-ground-ao-feet', this.footTexture, 0.85);

    this.body = this._mesh('ai-ground-ao-body', this.bodyMat, this.capacity, parent);
    this.feet = this._mesh('ai-ground-ao-feet', this.footMat, this.capacity * 2, parent);

    /* scratch — 毎フレーム経路はアロケーションしない */
    this._m = new Matrix4();
    this._q = new Quaternion();
    this._up = new Vector3(0, 1, 0);
    // 横倒し回転は 1 回だけ作る (Three 版と同じ -90° X 回転)
    this._flat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    this._scale = new Vector3(1, 1, 1);
    this._pos = new Vector3();
    this._foot = new Vector3();
    this._bodyBuf = new Float32Array(this.capacity * 16);
    this._feetBuf = new Float32Array(this.capacity * 2 * 16);
    this._nBody = 0;
    this._nFeet = 0;
  }

  _mesh(name, mat, count, parent) {
    const m = MeshBuilder.CreatePlane(name, { size: 1 }, this.scene);
    m.parent = parent;
    m.material = mat;
    // thin instance の行列は毎フレーム書き換えるのでカリング境界の再計算は
    // させず、常に active 扱いにする (2 ドローのコストは無視できる)。
    m.alwaysSelectAsActiveMesh = true;
    m.isPickable = false;
    m.metadata = { owNoShadow: true, owNoPrepass: true, owProbe: true };
    // FX の煙 (alphaIndex 高め) より先、不透明ワールドの後に描く。
    m.alphaIndex = 6;
    m.thinInstanceCount = 0;
    m.setEnabled(false);
    return m;
  }

  begin() {
    this._nBody = 0;
    this._nFeet = 0;
  }

  /** クアッド 1 枚を行列バッファ `buf` のインデックス i に書き込む。 */
  _place(buf, i, x, y, z, rx, rz, yaw) {
    // Three 版と同一の合成: yaw 回転 * 横倒し (列ベクトル規約)
    this._q.setFromAxisAngle(this._up, yaw).multiply(this._flat);
    this._pos.set(x, y + 0.015, z);
    this._scale.set(rx * 2, rz * 2, 1);
    this._m.compose(this._pos, this._q, this._scale);
    // math3 の elements (列優先) は Babylon の行列バッファと同レイアウト
    buf.set(this._m.elements, i * 16);
  }

  /** このフレームに積んだ分をアップロードする。 */
  end() {
    if (this._nBody > 0) {
      this.body.thinInstanceSetBuffer('matrix', this._bodyBuf, 16, false);
      this.body.thinInstanceCount = this._nBody;
      this.body.setEnabled(true);
    } else {
      this.body.setEnabled(false);
    }
    if (this._nFeet > 0) {
      this.feet.thinInstanceSetBuffer('matrix', this._feetBuf, 16, false);
      this.feet.thinInstanceCount = this._nFeet;
      this.feet.setEnabled(true);
    } else {
      this.feet.setEnabled(false);
    }
  }

  /**
   * アクター 1 体ぶんのクアッドを積む: 体の楕円 + ブーツごとのローブ。
   * 体の楕円は向きに合わせ、スタンス方向に長くする。
   */
  addActor(agent) {
    const p = agent.position;
    if (!p || !Number.isFinite(p.y)) return;
    const scale = agent.scale ?? 1;
    const crouch = agent.crouch ? 0.86 : 1;
    if (this._nBody < this.capacity) {
      this._place(this._bodyBuf, this._nBody++, p.x, p.y, p.z, 0.44 * scale * crouch, 0.34 * scale * crouch, agent.yaw);
    }
    const an = agent.animator;
    if (!an?.bonePos) return;
    for (const name of FEET) {
      if (this._nFeet >= this.capacity * 2) break;
      an.bonePos(name, this._foot);
      if (!Number.isFinite(this._foot.y)) continue;
      // 床から 6cm のブーツはまだ床を暗くする。35cm ではもうしない。接地は
      // フェードでなく縮む — 実物がそうだから。
      const h = this._foot.y - p.y;
      const k = 1 - Math.min(1, Math.max(0, (h - 0.06) / 0.29));
      if (k <= 0.05) continue;
      this._place(
        this._feetBuf,
        this._nFeet++,
        this._foot.x,
        p.y,
        this._foot.z,
        0.15 * scale * k,
        0.21 * scale * k,
        agent.yaw
      );
    }
  }

  dispose() {
    this.body.dispose();
    this.feet.dispose();
    this.bodyMat.dispose();
    this.footMat.dispose();
    this.texture.dispose();
    this.footTexture.dispose();
  }
}

const FEET = ['FootR', 'FootL'];
