/**
 * AI — 兵士マテリアルに注入する WGSL 断片。
 *
 * Three 版が `onBeforeCompile` で MeshStandardMaterial に差し込んでいた 2 つの
 * フックの移植先。Babylon では `MaterialPluginBase.getCustomCode()` が返す
 * 「注入点名 -> コード」の表として渡す (src/ai/shaderplugin.js)。
 *
 * ## 注入がいつ走るか — ここを取り違えると全部間違える
 *
 * plugin のコードは `processCodeAfterIncludes` として渡る。つまり
 *
 *   1. `#include<...>` の展開は **済んでいる**
 *   2. `#ifdef` の評価と WGSL プロセッサの行処理 (attribute/uniform/texture の
 *      binding 付与) は **まだ走っていない**
 *
 * この順序から次の 3 つが従う。**どれも「知らないと静かに壊れる」類**:
 *
 *   - 注入コードの中に `#ifdef` を書いてよい (むしろ書かないと、detail 無しの
 *     マテリアルにも detail のコードが混入する)
 *   - `var owDetailSampler: texture_2d<f32>;` のようなテクスチャ宣言を注入して
 *     よい。あとから WGSL プロセッサが `@group/@binding` を付けてくれる。
 *     もしこれが `processFinalCode` (プロセッサの後) だったら binding が付かず
 *     WGSL のコンパイルエラーになっていた
 *   - 正規表現の注入点 (`!` 始まり) がマッチする対象は **include 展開後・
 *     ifdef 評価前**の Babylon 純正ソースそのもの。Babylon を上げて 1 文字でも
 *     変われば **静かにマッチしなくなり、ディテールが黙って消える**。
 *     shaderplugin.js の `verifyInjection()` がこれを検出する唯一の仕掛けなので
 *     消さないこと
 *
 * ## 命名規約
 *
 * 注入した識別子は全部 `ow` プレフィックス。Babylon 側の巨大な名前空間 (main の
 * 関数スコープに数百の var が並ぶ) との衝突と、WGSL の予約語 (`macro` / `type` /
 * `set` / `shared` / `sample` …) の両方を一括で避けるため。
 * 予約語事故の詳細は ARCHITECTURE.md の「WGSL の罠」を参照。
 *
 * ## マーカーコメント
 *
 * 各断片は `OW_MARK_DETAIL_N` / `OW_MARK_DETAIL_R` / `OW_MARK_RIM` を含む。
 * これは飾りではなく **注入が実際に起きたことを機械的に確かめる唯一の手段**で、
 * shaderplugin.js の `verifyInjection()` がコンパイル済みシェーダ本文を grep する。
 * 注入が失敗しても Babylon は例外を投げず絵も「それらしく」出るため、これが
 * 無いと「移植したつもりで何も効いていない」状態に気付けない。消さないこと。
 */

/* ------------------------------------------------------------------ */
/* 1. 宣言 — detail タイルのサンプラ                                    */
/* ------------------------------------------------------------------ */

/**
 * `CUSTOM_FRAGMENT_DEFINITIONS` (pbr.fragment の main より前) に入る。
 *
 * uniform (`owDetailParams` / `owCharRim`) の方は plugin の `getUniforms()` が
 * マテリアル UBO に足すのでここには書かない。テクスチャだけは UBO に入らないため
 * 自前で宣言する必要がある。
 */
export const SOLDIER_DEFS_WGSL = /* wgsl */ `
#ifdef OW_DETAIL
var owDetailSamplerSampler: sampler;
var owDetailSampler: texture_2d<f32>;
#endif
`;

/* ------------------------------------------------------------------ */
/* 2. 高周波ディテールタイル — 法線                                     */
/* ------------------------------------------------------------------ */

/**
 * `CUSTOM_FRAGMENT_BEFORE_LIGHTS` に入る。ここは
 * `pbrBlockNormalGeometric` → `bumpFragment` → `pbrBlockNormalFinal` の **後**
 * なので `normalW` / `TBN` / `uvOffset` が全部生きており、かつ反射率ブロック
 * (roughness が決まる場所) の **前**。2 スケール系の高周波側を差し込むのに
 * ちょうどよい唯一の公式注入点。
 *
 * ## なぜ base 法線を「もう一度」サンプルするのか
 *
 * Babylon は `normalW = perturbNormal(TBN, tex, scale)` と、テクセルから
 * ワールド法線までを 1 行で済ませてしまう。ディテールを足すには
 * **正規化される前の tangent space** に戻る必要があるが、その中間値は残って
 * いない。そこで tangent 空間で組み直す:
 *
 *     n = normalize( vec3( base.xy * normalScale + detail.xy * detailStrength,
 *                          base.z ) )
 *     normalW = normalize( TBN * n )
 *
 * これは Three 版が `#include <normal_fragment_maps>` を差し替えて書いていた式と
 * 同じ。`perturbNormalBase` が `NORMALXYSCALE` のとき
 * `normalize(n * vec3(s,s,1))` を取ることまで含めて一致させてある。
 *
 * ## detail の法線を足す「前」に base を正規化しないこと
 *
 * 正規化してから足すと、base の傾きが急な場所 (縫い目・折り目) でディテールの
 * 寄与が相対的に増える。ripstop の格子が折り目の上だけ強く出るという、実物には
 * 無い見え方になる。
 *
 * ## 3 つ目のサンプルを増やさない
 *
 * `owDetailTexel` は **ブロックの外**で宣言している。alpha (roughness delta) を
 * 下の反射率フックが使い回すため。ここで `let` にして囲うと、下でもう一度
 * フェッチすることになる。
 *
 * `#ifdef BUMP` のガードは必須: goggle のガラスなど法線マップを持たない
 * マテリアルにも plugin (RIM 目的) が載るため、TBN も bumpSampler も存在しない
 * 経路がある。
 */
export const SOLDIER_DETAIL_WGSL = /* wgsl */ `
#ifdef OW_DETAIL
// OW_MARK_DETAIL_N
var owDetailTexel: vec4f = textureSample(
  owDetailSampler, owDetailSamplerSampler,
  fragmentInputs.vBumpUV * uniforms.owDetailParams.x);
#ifdef BUMP
{
  let owBaseN: vec3f = TEXRD(bumpSampler, bumpSamplerSampler,
    fragmentInputs.vBumpUV + uvOffset).xyz * 2.0 - vec3f(1.0);
  let owSlope: vec2f = (owDetailTexel.xy * 2.0 - vec2f(1.0)) * uniforms.owDetailParams.y;
  normalW = normalize(TBN * normalize(
    vec3f(owBaseN.xy * uniforms.vBumpInfos.y + owSlope, owBaseN.z)));
}
#endif
#endif
`;

/* ------------------------------------------------------------------ */
/* 3. 高周波ディテールタイル — roughness                                */
/* ------------------------------------------------------------------ */

/**
 * 反射率ブロックが返した roughness に、detail タイルの alpha (0.5 中心の符号つき
 * デルタ) を足す。**公式の注入点が無い**ので正規表現で行ごと差し替える。
 *
 * 対象は Babylon 9.18.1 の `pbr.fragment` のこの 1 行:
 *
 *     ...;var microSurface: f32=reflectivityOut.microSurface;var roughness: f32=reflectivityOut.roughness;var diffuseRoughness: ...
 *
 * `#else` 側で元の 2 文をそのまま復元しているので、`OW_DETAIL` が立っていない
 * マテリアル (肌・ポリマー・鋼・ゴム・ガラス) の絵は 1 ビットも変わらない。
 *
 * `microSurface` を `1 - roughness` で作り直しているのは、反射率ブロックが
 * まさにその関係で両者を出しているから (`roughness = 1 - microSurface`)。
 * 片方だけ動かすと alphaFresnel と radiance occlusion が食い違う。
 *
 * 下限 0.04 は Three 版から据え置き。ここを 0 まで許すと、weave の谷で
 * roughness が 0 に張り付き、布に鏡面のような点ハイライトが出る。
 */
export const SOLDIER_ROUGH_TARGET =
  'var microSurface: f32=reflectivityOut\\.microSurface;' +
  'var roughness: f32=reflectivityOut\\.roughness;';

export const SOLDIER_ROUGH_WGSL = /* wgsl */ `
#ifdef OW_DETAIL
// OW_MARK_DETAIL_R
var roughness: f32 = clamp(
  reflectivityOut.roughness + (owDetailTexel.w - 0.5) * uniforms.owDetailParams.z,
  0.04, 1.0);
var microSurface: f32 = 1.0 - roughness;
#else
var microSurface: f32 = reflectivityOut.microSurface;
var roughness: f32 = reflectivityOut.roughness;
#endif
`;

/* ------------------------------------------------------------------ */
/* 4. シルエットのエッジ減光 (RIM)                                      */
/* ------------------------------------------------------------------ */

/**
 * `CUSTOM_FRAGMENT_BEFORE_FOG` に入る。`pbrBlockFinalColorComposition` が
 * `finalColor` を組み上げ、emissive を足した直後・フォグとトーンマップの前。
 * Three 版が `#include <opaque_fragment>` の直前で `outgoingLight` を叩いていた
 * のと同じ位置になる。
 *
 * **`geometricNormalW` を使うこと。`normalW` ではない。** 後者は法線マップと
 * (上のフックで) ディテールタイルで擾乱済みなので、減光帯がテクスチャの高周波に
 * 乗って **カメラが動くたびに輪郭がざわつく**。Three 版が
 * `nonPerturbedNormal` を使っていたのはこの理由で、移植でここを取り違えると
 * 「遠景の敵の輪郭がちらつく」という別のバグに化ける。
 *
 * 係数の根拠 (実測値) は textures.js の `RIM` のコメントを参照。
 */
export const SOLDIER_RIM_WGSL = /* wgsl */ `
// OW_MARK_RIM
{
  let owFacing: f32 = 1.0 - abs(dot(viewDirectionW, geometricNormalW));
  let owEdge: f32 = pow(smoothstep(uniforms.owCharRim.y, 1.0, owFacing), uniforms.owCharRim.z);
  finalColor = vec4f(finalColor.rgb * (1.0 - uniforms.owCharRim.x * owEdge), finalColor.a);
}
`;
