/**
 * 派生マップ生成 — height から法線と ORM を作る 2 本のシェーダ。
 *
 * surface.wgsl が 1 パスで albedo(rgb) + height(a) を出すので、そこから
 *   - normal  : Sobel で height の勾配を取り接空間法線に
 *   - ORM     : R=AO, G=roughness, B=metallic
 * を派生させる。Babylon の PBRMaterial は ORM を 1 枚の metallicTexture として
 * 受け取れる (useAmbientOcclusionFromMetallicTextureRed /
 * useRoughnessFromMetallicTextureGreen / useMetallnessFromMetallicTextureBlue)。
 *
 * ## Sobel の幅は「テクセル 1 枚」でなければならない
 *
 * 幅を広げると法線がなまり、近接で見たときにディテールが消える。逆に狭すぎると
 * 量子化ノイズを拾う。`texel = 1/size` をそのまま使うのが正解で、size は
 * ProceduralTexture の解像度と厳密に一致させること — ここがズレると全サーフェスの
 * 法線強度が静かに変わり、しかも絵を見ても原因が分からない類のバグになる。
 */

export const WGSL_NORMAL = /* wgsl */ `
varying vUV: vec2f;
var srcSampler: sampler;
var src: texture_2d<f32>;
/** [テクセル幅, テクセル高, 起伏の強さ, 未使用] */
uniform texel: vec4f;

fn hAt(uv: vec2f) -> f32 {
  return textureSample(src, srcSampler, uv).a;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = input.vUV;
  let tx = uniforms.texel.x;
  let ty = uniforms.texel.y;

  // 3x3 Sobel。周期テクスチャなので端で fract() し、ラップさせる。
  // clamp してしまうと縁 1px だけ法線が寝て、タイルの継ぎ目に線が出る。
  let l  = hAt(fract(uv + vec2f(-tx,  0.0)));
  let r  = hAt(fract(uv + vec2f( tx,  0.0)));
  let d  = hAt(fract(uv + vec2f( 0.0, -ty)));
  let u  = hAt(fract(uv + vec2f( 0.0,  ty)));
  let lu = hAt(fract(uv + vec2f(-tx,  ty)));
  let ru = hAt(fract(uv + vec2f( tx,  ty)));
  let ld = hAt(fract(uv + vec2f(-tx, -ty)));
  let rd = hAt(fract(uv + vec2f( tx, -ty)));

  let dx = (ru + 2.0 * r + rd) - (lu + 2.0 * l + ld);
  let dy = (lu + 2.0 * u + ru) - (ld + 2.0 * d + rd);

  // 起伏 (relief) はメートル単位の凹凸をテクセル間隔で割った「勾配」。
  // library.js の bake.relief と worldSize からこの値が決まる。
  let s = uniforms.texel.z;
  let n = normalize(vec3f(-dx * s, -dy * s, 1.0));

  // 接空間法線を 0..1 に詰める。Babylon の bumpTexture は OpenGL 規約 (Y+ 上) を
  // 期待するので、invertY はマテリアル側では触らずここで完結させる。
  fragmentOutputs.color = vec4f(n * 0.5 + vec3f(0.5), 1.0);
}
`;

export const WGSL_ORM = /* wgsl */ `
varying vUV: vec2f;
var srcSampler: sampler;
var src: texture_2d<f32>;
/** [roughness 基準値, height→roughness の傾き, AO 強度, metallic] */
uniform orm: vec4f;
/** [テクセル幅, テクセル高, AO 半径(テクセル), 未使用] */
uniform texel: vec4f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = input.vUV;
  let s = textureSample(src, srcSampler, uv);
  let h = s.a;

  // AO は「周囲より低いほど暗い」で近似する。半径を変えた 2 スケールを混ぜると
  // 単一半径より自然になる (溝の底と、大きな凹みの両方が拾える)。
  let r1 = uniforms.texel.z;
  let r2 = r1 * 3.0;
  var occ1 = 0.0;
  var occ2 = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let a = f32(i) * 0.78539816; // 45deg 刻み
    let o = vec2f(cos(a), sin(a));
    occ1 = occ1 + textureSample(src, srcSampler, fract(uv + o * vec2f(uniforms.texel.x, uniforms.texel.y) * r1)).a;
    occ2 = occ2 + textureSample(src, srcSampler, fract(uv + o * vec2f(uniforms.texel.x, uniforms.texel.y) * r2)).a;
  }
  occ1 = occ1 / 8.0;
  occ2 = occ2 / 8.0;
  let cav = clamp((occ1 - h) * 2.2, 0.0, 1.0) * 0.6 + clamp((occ2 - h) * 1.4, 0.0, 1.0) * 0.4;
  let ao = clamp(1.0 - cav * uniforms.orm.z, 0.0, 1.0);

  // roughness は height に連動させる。凹んだ所 (汚れが溜まる所) は粗く、
  // 出っ張り (擦れて磨かれる所) は滑らか — というのが現実の摩耗の向き。
  let rough = clamp(uniforms.orm.x + (h - 0.5) * uniforms.orm.y, 0.03, 1.0);

  fragmentOutputs.color = vec4f(ao, rough, uniforms.orm.w, 1.0);
}
`;
