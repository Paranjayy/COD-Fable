/**
 * パーティクルの WGSL — **ステートレス GPU パーティクル**。
 *
 * ## 設計 (Three 版から引き継いだ、この実装の肝)
 *
 * CPU 側はパーティクルを **一度も更新しない**。生成時に「初期位置・初期速度・
 * 抗力・重力・寿命・生誕時刻」を書き込んだら、あとは毎フレーム `uTime` を渡すだけで
 * 頂点シェーダが解析解から現在位置を求める。
 *
 *   抗力 k のもとでの運動方程式  dv/dt = -k v + g  の解:
 *     v(t) = v0 e^(-kt) + (g/k)(1 - e^(-kt))
 *     x(t) = x0 + (v0 - g/k)(1 - e^(-kt))/k + (g/k) t
 *
 * これにより:
 *   - CPU の更新ループが存在しない (24k 粒子でも CPU 負荷ゼロ)
 *   - **フレームレートに依存しない**。60fps でも 15fps でも同じ位置に居る
 *   - キャプチャの決定性が保たれる (積分誤差の蓄積が無い)
 *
 * 代償は「途中で軌道を変えられない」こと。跳ね返りは別粒子として撃ち直す
 * (impacts.js の spark が bounce を予測レイキャストで先に解いているのはこのため)。
 *
 * ## 属性のパッキング
 *
 * 1 粒子 = 32 float (8 x vec4)。**インスタンス属性ではなく頂点属性**として、
 * 粒子ごとの 4 頂点すべてに同じ値を持たせる (理由は particles.js のコメント参照)。
 * `position.xy` だけが頂点ごとに変わり、クアッドの隅を表す。
 *
 *   aPS    pos.xyz, size0
 *   aVS    vel.xyz, size1
 *   aLife  birth, 1/life, drag, gravity
 *   aRot   rot0, spin, stretch, sizeCurve
 *   aCol0  colourA.rgb, intensityA
 *   aCol1  colourB.rgb, intensityB
 *   aMisc  tile, softness, alpha, alphaCurve
 *   aExtra turbAmp, turbFreq, seed, flags
 */

/**
 * 頂点シェーダ。
 *
 * `defines` で LIT / SOFT / ADDITIVE を切り替える。Babylon の ShaderMaterial は
 * `#define` を options.defines で渡せる。
 */
export const WGSL_PARTICLE_VERT = /* wgsl */ `
attribute position: vec3f;
attribute uv: vec2f;

attribute aPS: vec4f;
attribute aVS: vec4f;
attribute aLife: vec4f;
attribute aRot: vec4f;
attribute aCol0: vec4f;
attribute aCol1: vec4f;
attribute aMisc: vec4f;
attribute aExtra: vec4f;

uniform view: mat4x4f;
uniform projection: mat4x4f;
uniform uTime: f32;
/** [列数, 1/列数, 0, 0] */
uniform uAtlas: vec4f;

varying vUv: vec2f;
varying vCol: vec4f;
varying vViewZ: f32;
varying vSoft: f32;
varying vQ: vec2f;
varying vAge: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let t = uniforms.uTime - input.aLife.x;
  let n = t * input.aLife.y;

  if (t < 0.0 || n >= 1.0) {
    // 生前・死後は far plane の外へ飛ばしてクリップさせる。discard より安い。
    vertexOutputs.vUv = vec2f(0.0);
    vertexOutputs.vCol = vec4f(0.0);
    vertexOutputs.vViewZ = 1.0;
    vertexOutputs.vSoft = 1.0;
    vertexOutputs.vQ = vec2f(0.0);
    vertexOutputs.vAge = 0.0;
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    return vertexOutputs;
  }

  let k = max(input.aLife.z, 0.02);
  let e = exp(-k * t);
  let gk = vec3f(0.0, input.aLife.w, 0.0) / k;
  var wpos = input.aPS.xyz + (input.aVS.xyz - gk) * ((1.0 - e) / k) + gk * t;
  var wvel = input.aVS.xyz * e + gk * (1.0 - e);

  /**
   * 乱流。相関のない 3 本の正弦。
   *
   * grow で立ち上がりを鈍らせるのは、生成 1 フレーム目に粒子が瞬間移動して
   * 見えるのを防ぐため。速度側にも寄与させるのは、たなびく煙が伸びる向きを
   * 正しくするため (stretch が速度方向を使う)。
   */
  let ph = input.aExtra.z * 6.2831853;
  let f = input.aExtra.y;
  let grow = smoothstep(0.0, 0.4, n);
  let amp = input.aExtra.x * grow;
  wpos = wpos + vec3f(sin(t * f * 1.13 + ph), sin(t * f * 0.79 + ph * 2.1), cos(t * f * 1.31 + ph * 1.7)) * amp;
  wvel = wvel + vec3f(cos(t * f * 1.13 + ph), cos(t * f * 0.79 + ph * 2.1), -sin(t * f * 1.31 + ph * 1.7)) * (amp * f);

  var mv = uniforms.view * vec4f(wpos, 1.0);
  let velView = (uniforms.view * vec4f(wvel, 0.0)).xyz;

  let size = mix(input.aPS.w, input.aVS.w, pow(n, max(input.aRot.w, 0.02)));
  let c = input.position.xy;
  var off = vec2f(0.0);

  if (input.aRot.z > 0.001) {
    // 速度方向に伸ばす (火花の尾)。スプライトの +Y が画面上の速度方向になる。
    let d = velView.xy;
    let dl = length(d);
    let along = select(vec2f(0.0, 1.0), d / dl, dl > 1e-5);
    let perp = vec2f(-along.y, along.x);
    let len = size * (1.0 + input.aRot.z * length(velView));
    off = along * (c.y * len) + perp * (c.x * size);
  } else {
    let rot = input.aRot.x + input.aRot.y * t;
    let s = sin(rot);
    let co = cos(rot);
    off = vec2f(c.x * co - c.y * s, c.x * s + c.y * co) * size;
  }
  mv = vec4f(mv.x + off.x, mv.y + off.y, mv.z, mv.w);

  vertexOutputs.vViewZ = -mv.z;
  vertexOutputs.vSoft = max(input.aMisc.y, 0.002);
  vertexOutputs.vQ = off / max(size, 1e-4) * 2.0;
  vertexOutputs.vAge = n;
  vertexOutputs.position = uniforms.projection * mv;

  let tuv = vec2f(input.aMisc.x % uniforms.uAtlas.x, floor(input.aMisc.x * uniforms.uAtlas.y));
  vertexOutputs.vUv = (input.uv + tuv) * uniforms.uAtlas.y;

  let col = mix(input.aCol0.rgb, input.aCol1.rgb, n);
  var inten = mix(input.aCol0.w, input.aCol1.w, n * n);
  // flags=1 は火花。ちらつかせる。
  if (input.aExtra.w > 0.5) {
    inten = inten * (0.72 + 0.28 * sin(t * 63.0 + ph * 9.0));
  }
  let a = input.aMisc.z * pow(max(1.0 - n, 0.0), max(input.aMisc.w, 0.02)) * smoothstep(0.0, 0.045, n);
  vertexOutputs.vCol = vec4f(col * inten, a);
  return vertexOutputs;
}
`;

export const WGSL_PARTICLE_FRAG = /* wgsl */ `
varying vUv: vec2f;
varying vCol: vec4f;
varying vViewZ: f32;
varying vSoft: f32;
varying vQ: vec2f;
varying vAge: f32;

var uSpriteSampler: sampler;
var uSprite: texture_2d<f32>;

/** ビュー空間の太陽方向 (太陽の側を向く)。 */
uniform uSunDir: vec3f;
uniform uSunCol: vec3f;
uniform uAmbTop: vec3f;
uniform uAmbBot: vec3f;
/** ビュー空間の上方向。 */
uniform uUpView: vec3f;
/** rgb=フォグ色, w=密度 */
uniform uFog: vec4f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let tex = textureSample(uSprite, uSpriteSampler, input.vUv);

  /**
   * **微分は discard より前で取る。**
   *
   * WGSL の dpdx / dpdy は **一様な制御フローの中でしか使えない**。discard の
   * 後に置くと、隣接ピクセルが破棄されたときの微分が未定義になり、WebGPU が
   * パイプラインを不正と判定する。
   *
   * 実際にこれを踏んだときの症状: パーティクルを 1 つでも出すと
   * **シーン全体が真っ黒**になった。エラーはブラウザ console に GPUValidationError
   * として出るが、内容は「PostProcessRTT-highlights の RenderPipeline が
   * 以前のエラーにより不正」という **まったく別のパス**を指しており、原因の
   * パーティクルシェーダには一言も言及しない。1 つの不正パイプラインが
   * コマンドバッファ全体を無効化するため、後続のポストパスが巻き添えで倒れる。
   */
  let dTexX = dpdx(tex.r);
  let dTexY = dpdy(tex.r);

  if (input.vCol.a <= 0.0) { discard; }
  var a = tex.a * input.vCol.a;
  if (a < 0.0035) { discard; }
  var c = input.vCol.rgb * tex.rgb;

  #ifdef LIT
    /**
     * 板ポリを「球」に見せかけて陰影を付ける。
     *
     * vQ はスプライト内の -1..1 座標。そこから偽の法線を作り、**スプライト自身の
     * 密度勾配で曲げる**。これが「ただのぼやけた円」を「内部構造のある煙」に変える
     * 唯一の処理なので、勾配の項を外さないこと。
     */
    let rr = dot(input.vQ, input.vQ);
    var nrm = vec3f(input.vQ, sqrt(max(0.03, 1.0 - rr)));
    nrm = normalize(nrm - vec3f(dTexX, dTexY, 0.0) * 7.0);
    let ndl = dot(nrm, uniforms.uSunDir);
    // wrap ライティング。半透明の媒質は裏からも透ける。
    let wrap = max(0.0, (ndl + 0.42) / 1.42);
    let back = max(0.0, -ndl);
    let up = 0.5 + 0.5 * dot(nrm, uniforms.uUpView);
    /**
     * irradiance → radiance の 1/PI。これが無いと埃の塊だけが背後の壁より
     * 明るくなり、露出が合わなくなる。
     */
    var lit = (mix(uniforms.uAmbBot, uniforms.uAmbTop, up)
             + uniforms.uSunCol * (wrap * 0.9 + pow(back, 4.0) * 0.55)) * 0.3183099;
    // 密度による自己遮蔽。
    lit = lit * mix(1.0, 0.55, clamp(tex.a * 1.1, 0.0, 1.0));
    c = c * lit;
  #endif

  // レンズに張り付くのを防ぐ。近すぎる粒子は消す。
  a = a * clamp((input.vViewZ - 0.05) / 0.2, 0.0, 1.0);

  let fogAmt = 1.0 - exp(-uniforms.uFog.w * input.vViewZ);
  #ifdef ADDITIVE
    // 加算合成ではフォグは「減衰」として効く (混ぜるのではなく弱める)。
    c = c * (1.0 - fogAmt);
    fragmentOutputs.color = vec4f(c * a, a);
  #else
    c = mix(c, uniforms.uFog.rgb, fogAmt);
    fragmentOutputs.color = vec4f(c, a);
  #endif
}
`;
