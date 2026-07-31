/**
 * デカール (弾痕・血糊・焦げ跡) の WGSL。
 *
 * ## なぜ「面に貼る板」で、ジオメトリを切り抜かないのか
 *
 * Babylon には `MeshBuilder.CreateDecal` があり、対象メッシュを実際にクリップして
 * 面に沿った形状を作れる。角を回り込む表現には必要だが:
 *
 *   - 1 枚ごとにジオメトリのクリップが走る (弾痕は毎秒数十枚出る)
 *   - ワールドが統合済みメッシュなので、クリップ対象が街全体になり非現実的
 *
 * ここでは法線に沿って 1cm 浮かせた板を貼る。角では途切れるが、弾痕サイズ
 * (5〜10cm) では実用上ほとんど気にならない。**大きな爆発痕を足すときは
 * この判断を見直すこと** (大きい板ほど角の破綻が目立つ)。
 *
 * ## Z ファイティング対策
 *
 * 浮かせるだけでは斜めから見たときに壁に埋もれる。深度テストは LESS_EQUAL のまま、
 * **深度を書かない**。書くと後から貼ったデカールが先のものを消す。
 */
export const WGSL_DECAL_VERT = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;

/** xyz = 中心位置, w = 半径 (m) */
attribute aPos: vec4f;
/** 面の接空間。xyz = 法線, w = 回転角 (rad) */
attribute aNrm: vec4f;
/** tile, birth, 1/life, alpha */
attribute aMisc: vec4f;
/** rgb = 色, a = 未使用 */
attribute aCol: vec4f;

uniform viewProjection: mat4x4f;
uniform uTime: f32;
/** [列数, 1/列数, 0, 0] */
uniform uAtlas: vec4f;

varying vUv: vec2f;
varying vCol: vec4f;
varying vNrm: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let age = (uniforms.uTime - input.aMisc.y) * input.aMisc.z;
  if (age < 0.0 || age >= 1.0) {
    vertexOutputs.vUv = vec2f(0.0);
    vertexOutputs.vCol = vec4f(0.0);
    vertexOutputs.vNrm = vec3f(0.0, 1.0, 0.0);
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    return vertexOutputs;
  }

  let n = normalize(input.aNrm.xyz);
  /**
   * 法線から接空間を作る。
   *
   * 法線が Y 軸とほぼ平行なとき (床・天井) に up=(0,1,0) を使うと外積がゼロになり
   * 接空間が壊れる。**必ず軸を切り替えること** — これを忘れると床の弾痕だけが
   * 消えるという、気付きにくい壊れ方をする。
   */
  let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.94);
  var t = normalize(cross(up, n));
  var b = cross(n, t);

  // 面内での回転。同じ弾痕が並んだときに同じ向きに見えないようにする。
  let ca = cos(input.aNrm.w);
  let sa = sin(input.aNrm.w);
  let t2 = t * ca + b * sa;
  let b2 = b * ca - t * sa;

  let r = input.aPos.w;
  // 1cm 浮かせる。面と同一平面だと Z ファイティングで斑になる。
  let world = input.aPos.xyz + n * 0.01 + t2 * (input.position.x * r * 2.0) + b2 * (input.position.y * r * 2.0);

  vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
  vertexOutputs.vNrm = n;

  let tuv = vec2f(input.aMisc.x % uniforms.uAtlas.x, floor(input.aMisc.x * uniforms.uAtlas.y));
  vertexOutputs.vUv = (input.uv + tuv) * uniforms.uAtlas.y;

  // 寿命の終わり 25% でフェードアウトする。突然消えると目に付く。
  let fade = smoothstep(1.0, 0.75, age);
  vertexOutputs.vCol = vec4f(input.aCol.rgb, input.aMisc.w * fade);
  return vertexOutputs;
}
`;

export const WGSL_DECAL_FRAG = /* wgsl */ `
varying vUv: vec2f;
varying vCol: vec4f;
varying vNrm: vec3f;

var uSpriteSampler: sampler;
var uSprite: texture_2d<f32>;

uniform uSunDir: vec3f;
uniform uSunCol: vec3f;
uniform uAmb: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let tex = textureSample(uSprite, uSpriteSampler, input.vUv);
  let a = tex.a * input.vCol.a;
  if (a < 0.004) { discard; }

  /**
   * デカールは下地の陰影を引き継ぐべきだが、下地の色を読む手段が無い (前方描画)。
   * ここでは面法線に対する簡易ライティングだけを掛ける。**明るさを合わせるのは
   * 露出ではなくこの係数**で行うこと (露出を触ると画面全体が動く)。
   */
  let ndl = max(0.0, dot(input.vNrm, uniforms.uSunDir));
  let lit = uniforms.uAmb + uniforms.uSunCol * ndl;
  let c = input.vCol.rgb * tex.rgb * lit;

  fragmentOutputs.color = vec4f(c, a);
}
`;
