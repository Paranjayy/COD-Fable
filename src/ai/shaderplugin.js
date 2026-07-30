/**
 * AI — 兵士マテリアル用の Babylon MaterialPlugin。
 *
 * Three 版の `_attachShader()` (onBeforeCompile + customProgramCacheKey) の移植先。
 * 2 つの効果を 1 つの plugin に載せている:
 *
 *   1. **高周波ディテールタイル** — 2 スケールカモの高周波側。5 cm/512 px の
 *      weave / ripstop 格子 / nylon リブを tangent space 法線 + roughness デルタ
 *      としてベース材質に混ぜる (textures.js の `bakeDetail` が焼く)。
 *   2. **シルエットのエッジ減光 (RIM)** — 逆光で輪郭が空に溶けるのを防ぐ。
 *
 * WGSL 本体は `./wgsl/soldier.js`。ここはその配線 (define / uniform / sampler /
 * バインド) だけを持つ。
 *
 * ## なぜ 1 つの plugin に 2 つ載せるのか
 *
 * plugin ごとに Babylon は `MATERIALPLUGIN_<n>` という define を 1 本増やす。
 * 分けると define が 2 本になり、プログラムキャッシュのキー空間が倍になるだけで
 * 得が無い。Three 版が 1 つの onBeforeCompile に両方入れていたのと同じ理由。
 *
 * ## プログラムキャッシュの罠 (Three 版のコメントがここでも効く)
 *
 * Three 版には「`customProgramCacheKey` は必須。無いと three が detail 入りの
 * プログラムを skin マテリアルに渡してしまう」という注意書きがあった。Babylon
 * でも **同じ事故が起きる**: effect のキャッシュキーは defines 文字列なので、
 * 「detail 有り」と「detail 無し」が同じ defines なら同じプログラムを共有する。
 *
 * だから detail の有無は **必ず `OW_DETAIL` という define で表す**。
 * `getCustomCode()` の中で JS の if で分岐して別々のコードを返す実装にすると、
 * defines が同じまま中身だけ違うコードになり、先にコンパイルされた方のプログラムが
 * もう一方にも配られる。**エラーは出ない。肌に布の織り目が乗る、あるいは布から
 * 織り目が消える**という形でしか現れない。
 *
 * scale / 強度 / RIM 係数は uniform なので、値が違うだけならプログラムは共有して
 * よい (キーに含める必要はない)。
 *
 * ## 副作用 import
 *
 * `materialPluginBase.js` (`.pure.js` ではない) を import すること。純粋版は
 * `RegisterMaterialPluginBase()` を呼ばず、シリアライズ経路でクラスが解決できなく
 * なる。ARCHITECTURE.md の「副作用 import」節と同じ種類の罠。
 */
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import '@babylonjs/core/Materials/materialPluginManager.js';

import {
  SOLDIER_DEFS_WGSL,
  SOLDIER_DETAIL_WGSL,
  SOLDIER_ROUGH_TARGET,
  SOLDIER_ROUGH_WGSL,
  SOLDIER_RIM_WGSL,
} from './wgsl/soldier.js';

/**
 * plugin の実行順。Babylon 純正の DetailMap が 140、PBR 本体系が 100 未満なので
 * それより後ろ。ここは「他の plugin のコードとぶつかったときにどちらが後に
 * 注入されるか」しか決めないので、値そのものに深い意味は無い。
 */
const PRIORITY = 260;

export class SoldierSurfacePlugin extends MaterialPluginBase {
  /**
   * @param material  親の PBRMaterial
   * @param opts      {
   *                    detail?: { texture, scale, normal, rough },
   *                    rim: { strength, edge, power }
   *                  }
   *
   * `detail.scale` はベースタイルの UV を detail タイルの UV に変換する係数
   * (ベースの m/tile ÷ 0.05 m)。これにより袖・ポーチ・ブーツで糸の物理サイズが
   * 揃う — 部位ごとの手調整が要らないのはこの 1 数値のおかげ。
   */
  constructor(material, opts = {}) {
    // 第 4 引数の defines は「plugin が使う define 名 -> 既定値」。ここに載せた
    // 名前だけが prepareDefines で書き換えられ、かつ effect のキャッシュキーに入る。
    super(material, 'OwSoldierSurface', PRIORITY, { OW_DETAIL: false }, true, true);

    this._detail = opts.detail ?? null;
    const rim = opts.rim ?? { strength: 0, edge: 0.5, power: 2 };
    this._rimStrength = rim.strength;
    this._rimEdge = rim.edge;
    this._rimPower = rim.power;
  }

  getClassName() {
    return 'SoldierSurfacePlugin';
  }

  /**
   * 既定の実装は **GLSL のときだけ true** を返す。上書きしないと WebGPU 経路で
   * plugin が丸ごと無効化され、**エラーも警告も出ないまま何も起きない**。
   */
  isCompatible() {
    return true;
  }

  prepareDefines(defines) {
    defines.OW_DETAIL = !!this._detail;
  }

  isReadyForSubMesh() {
    // detail タイルは CPU ベイクを RawTexture に上げたものなので、生成直後から
    // ready。それでも待つのは「未 ready のテクスチャをバインドすると WebGPU が
    // バインドグループを作れず、そのフレームのコマンドバッファごと落ちる」から。
    return !this._detail || this._detail.texture.isReady();
  }

  getSamplers(samplers) {
    if (this._detail) samplers.push('owDetailSampler');
  }

  /**
   * `owDetailParams` は vec3 で足りるが **vec4 で取っている**。std140 / WGSL の
   * uniform レイアウトでは vec3 も 16 byte にアラインされるため、詰めても 1 byte も
   * 得しない一方、CPU 側 (`updateFloat3`) と GPU 側のパディング解釈がずれたときの
   * 症状 (隣の uniform が壊れる) が極めて追いにくい。
   */
  getUniforms() {
    return {
      ubo: [
        // x=UV スケール, y=法線強度, z=roughness 強度, w=未使用
        { name: 'owDetailParams', size: 4, type: 'vec4' },
        // x=減光の強さ, y=エッジ開始 (|N.V|), z=べき, w=未使用
        { name: 'owCharRim', size: 4, type: 'vec4' },
      ],
    };
  }

  bindForSubMesh(uniformBuffer, scene) {
    const frozen = this._material.isFrozen;
    if (!uniformBuffer.useUbo || !frozen || !uniformBuffer.isSync) {
      const d = this._detail;
      uniformBuffer.updateFloat4(
        'owDetailParams',
        d ? d.scale : 1,
        d ? d.normal : 0,
        d ? d.rough : 0,
        0
      );
      uniformBuffer.updateFloat4('owCharRim', this._rimStrength, this._rimEdge, this._rimPower, 0);
    }
    if (this._detail && scene.texturesEnabled) {
      uniformBuffer.setTexture('owDetailSampler', this._detail.texture);
    }
  }

  hasTexture(texture) {
    return !!this._detail && this._detail.texture === texture;
  }

  getActiveTextures(activeTextures) {
    if (this._detail) activeTextures.push(this._detail.texture);
  }

  /**
   * detail タイルは `SoldierMaterials` が所有し `_disposables` でまとめて解放する。
   * plugin 側で dispose すると、同じタイルを共有する他のマテリアルが死ぬ。
   */
  dispose() {}

  getCustomCode(shaderType) {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: SOLDIER_DEFS_WGSL,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: SOLDIER_DETAIL_WGSL,
      // `!` 始まりは正規表現による行差し替え。詳細と壊れ方は wgsl/soldier.js を参照。
      [`!${SOLDIER_ROUGH_TARGET}`]: SOLDIER_ROUGH_WGSL,
      CUSTOM_FRAGMENT_BEFORE_FOG: SOLDIER_RIM_WGSL,
    };
  }
}

/**
 * **注入が本当に起きたかをコンパイル済みシェーダ本文で検証する。**
 *
 * このプロジェクトで最も高頻度に踏んだ失敗は「エラーが出ない = 動いた」と
 * 読み替えることだった。plugin の注入は次のどれが外れても **例外も警告も出さずに
 * 無言で無効化される**:
 *
 *   - `isCompatible()` の上書き忘れ (WGSL では既定が false)
 *   - Babylon 更新で `pbr.fragment` の 1 行が変わり、roughness の正規表現が
 *     マッチしなくなる
 *   - 注入点名の綴り違い / 将来の削除
 *
 * どれも「ディテールが乗っていない絵」が普通に出るだけなので、目視では
 * 気付けない。だからマテリアルの effect が出来た瞬間に本文を grep して、
 * 期待するマーカーが無ければ **console.error で名指しする**。
 *
 * 結果は `SoldierMaterials.injection` に溜まり、キャプチャ用のプローブから
 * 読める (`ai.materials.injection`)。
 *
 * ## `executeWhenCompiled` を挟む理由 (ここで一度誤検知した)
 *
 * `onEffectCreatedObservable` は **Effect オブジェクトが作られた時点**で発火する。
 * シェーダのロードと処理は非同期なので、その瞬間の `fragmentSourceCode` は
 * まだ空文字列で、素直に読むと **全マテリアルが「注入失敗」に見える**。
 * 実際にはマーカーは全部入っていた。検証器そのものが偽陽性を出すと、正しい実装を
 * 疑って時間を溶かすことになるので、必ずコンパイル完了を待ってから読むこと。
 *
 * @param material     検証対象の PBRMaterial
 * @param expectDetail このマテリアルが detail タイルを持つ想定か
 * @param report       結果を書き込む配列
 */
export function verifyInjection(material, expectDetail, report) {
  material.onEffectCreatedObservable.add(({ effect }) => {
    effect.executeWhenCompiled(() => checkEffect(material, effect, expectDetail, report));
  });
}

function checkEffect(material, effect, expectDetail, report) {
  const src = effect.fragmentSourceCode ?? '';
  const row = {
    material: material.name,
    rim: src.includes('OW_MARK_RIM'),
    detailNormal: src.includes('OW_MARK_DETAIL_N'),
    detailRough: src.includes('OW_MARK_DETAIL_R'),
    expectDetail: !!expectDetail,
  };
  row.ok = row.rim && row.detailNormal === row.expectDetail && row.detailRough === row.expectDetail;
  report.push(row);
  if (!row.ok) {
    console.error(
      `[ai] シェーダ注入が効いていない: ${material.name} ` +
        `rim=${row.rim} detailN=${row.detailNormal} detailR=${row.detailRough} ` +
        `(detail 期待=${row.expectDetail})。src/ai/wgsl/soldier.js の注入点を確認すること。`
    );
  }
}
