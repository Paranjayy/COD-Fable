import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ReflectionProbe } from '@babylonjs/core/Probes/reflectionProbe.js';
import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { SphericalHarmonics, SphericalPolynomial } from '@babylonjs/core/Maths/sphericalPolynomial.js';
/**
 * **副作用 import。消さないこと。**
 *
 * `BaseTexture.sphericalPolynomial` は Babylon 9 ではツリーシェイキング対象で、
 * このモジュールを import して初めてプロパティが生える。無いと素の baseTexture が
 * 「未実装プロパティ」のスタブを返す。
 *
 * 質の悪いことに、PBR 側は **反射テクスチャがキューブなら SH を使うと決め打つ**
 * (materialHelper.functions.js: 「Assume using spherical polynomial if the
 * reflection texture is a cube map」)。したがって import を忘れると、描画のたびに
 * `BindIBLParameters` が `polynomials.l00` を読もうとして
 * 「Cannot read properties of undefined」で落ちる。エラーは sky ではなく
 * PBRMaterial.bindForSubMesh に出るので、原因に辿り着きにくい。
 */
import '@babylonjs/core/Materials/Textures/baseTexture.polynomial.js';

import { WGSL_ATMOSPHERE } from './wgsl/atmosphere.js';
import { Celestial } from './celestial.js';

/**
 * SKY — 物理ベースの大気、太陽/月、時刻、IBL、フォグ。
 *
 * ## 責務
 *
 *   - 空ドームを描く (WGSL の単一散乱大気)
 *   - 太陽と月の DirectionalLight を動かす
 *   - **シーンの環境光 (IBL) を空から生成する** ← これが一番重要
 *   - 距離フォグの色を空と一致させる
 *
 * ## IBL の作り方と、その限界
 *
 * 空ドームを ReflectionProbe (キューブ RTT) に焼き、それを
 * `scene.environmentTexture` にする。さらに球面調和 (SH) を計算して拡散環境光に
 * 使う。**時刻が変わったときだけ**焼き直す — 毎フレーム焼くと 6 面ぶんの描画が
 * 乗るうえ、TAA の収束を壊す。
 *
 * **限界**: これは GGX 事前フィルタではない。粗いマテリアルの反射はキューブの
 * ミップで近似しているだけで、正しい重要度サンプリングをしていない。README の
 * 「Indirect light — An approximation, not real GI」という自己評価はこの構成でも
 * 引き続き当てはまる。改善するなら render 側に IblShadowsRenderPipeline を足す。
 */

/** 気象の既定値。setWeather で上書きできる。 */
const DEFAULT_WEATHER = {
  /** Mie 散乱の量。砂塵の街なので既定はやや高め。 */
  turbidity: 2.4,
  /** 距離フォグの密度。 */
  fogDensity: 0.0042,
  /** 太陽光の強さ。 */
  sunIntensity: 22.0,
  /**
   * 空の放射輝度スケール。**太陽と同じ単位系に揃えるための係数**。
   *
   * ## なぜ必要か (実測で判明した問題)
   *
   * `_skyColorFor` が返す色は「見た目の空の色」(0..1) で、一方 sun.intensity は 22。
   * この 2 つを別スケールのまま SH に積むと、日向と日陰の明度差が現実離れする。
   *
   * 実測 (hero ショット, 16:30, 1280x720 の領域平均):
   *   空          RGB 117/145/172
   *   日向の壁    RGB 109/ 90/ 65
   *   日陰の壁    RGB  26/ 23/ 19   ← 日向の 1/4。晴天屋外としては暗すぎる
   *   路面        RGB  18/ 18/ 19   ← ほぼ黒
   *
   * 現実の晴天では日陰は日向の 1/5〜1/8 (線形) だが、トーンマップ後の表示値では
   * もっと持ち上がる。日陰が 26 まで落ちるのは「空からの拡散光が太陽に対して
   * 1/30 しかない」ことが原因で、露出の問題ではない。
   *
   * **ここを上げずに露出で持ち上げると空が白飛びする**。ARCHITECTURE.md の
   * 「exposure-driven not multiplier-driven」は「露出で全部やれ」という意味ではなく、
   * 「明るさの辻褄をマテリアルの色で合わせるな」という意味。光源の相対強度は
   * 光源側で正すのが正しい。
   */
  skyIrradiance: 5.5,
};

export class SkySystem {
  static id = 'sky';
  static deps = [];

  constructor() {
    /** 0..24 の時刻。 */
    this.hours = 16.5;
    /** 1 秒あたりに進む時間 (時)。0 で停止。 */
    this.timeRate = 0;
    this.weather = { ...DEFAULT_WEATHER };
    /** 太陽・月の実位置 (球面天文学)。時刻→位置の対応はショットリストとの契約。 */
    this.celestial = new Celestial();
    this._envDirty = true;
    this._envAccum = 0;
    /** skyParams の再利用バッファ。毎フレーム new しない (Hard rule 5)。 */
    this._skyParams = new Vector4(0, 0, 0, 0);
  }

  async init(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.webgpu = ctx.backend === 'webgpu';

    if (this.webgpu) this._registerShader();

    /**
     * 空ドーム。
     *
     * `infiniteDistance` を使わず、十分大きい球を **カメラに追従**させる。
     * infiniteDistance は深度を潰すため、後段の深度依存パス (フォグ、SSR、
     * モーションブラーの velocity) が空を「距離ゼロ」と解釈して破綻する。
     */
    const dome = MeshBuilder.CreateSphere('skyDome', { diameter: 2000, segments: 32 }, this.scene);
    dome.layerMask = ctx.LAYER.WORLD;
    dome.material = this._makeSkyMaterial();
    // 内側から見るので背面を描く。
    dome.material.backFaceCulling = false;
    dome.material.disableDepthWrite = true;
    dome.isPickable = false;
    dome.receiveShadows = false;
    /** 物理コライダを付けない / 影を落とさない印。physics と render が見る。 */
    dome.metadata = { owNoCollision: true, owNoShadow: true };
    dome.renderingGroupId = 0;
    this.dome = dome;

    /** 太陽。CSM の光源になるので render 側がこれを掴む。 */
    this.sun = new DirectionalLight('sun', new Vector3(0, -1, 0), this.scene);
    this.sun.intensity = 0;
    this.sun.shadowMinZ = 0.1;
    this.sun.shadowMaxZ = ctx.config.q.shadowDistance ?? 140;

    /** 月。夜間の弱い指向光。 */
    this.moon = new DirectionalLight('moon', new Vector3(0, -1, 0), this.scene);
    this.moon.intensity = 0;

    /**
     * 空からの半球光。
     *
     * IBL があるのになぜ半球光も要るのか: ReflectionProbe 由来の環境マップは GGX
     * 事前フィルタではないため拡散成分が実際より暗く出る。空色/地面色を持つ弱い
     * HemisphericLight で底上げする。**強くしすぎると影が浮く**ので、あくまで補助。
     */
    this.ambient = new HemisphericLight('skyAmbient', new Vector3(0, 1, 0), this.scene);
    this.ambient.intensity = 0.35;
    this.ambient.diffuse = new Color3(0.55, 0.68, 0.9);
    this.ambient.groundColor = new Color3(0.28, 0.24, 0.19);

    /**
     * 環境マップ生成用のプローブ。空ドームだけを写す。
     *
     * 解像度 128 は「拡散 IBL と粗い反射には十分、焼き直しが速い」の折衷。
     * 上げても鏡面の解像感は SSR 側の問題なのでここでは効かない。
     */
    this.probe = new ReflectionProbe('skyProbe', 128, this.scene, false);
    this.probe.renderList.push(dome);
    // 手動で焼く。自動更新すると毎フレーム 6 面ぶんの描画が乗る。
    this.probe.cubeTexture.refreshRate = 0;
    this.scene.environmentTexture = this.probe.cubeTexture;
    this.scene.environmentIntensity = 1.0;

    this.scene.fogMode = Constants.FOGMODE_EXP2;
    this.scene.fogDensity = this.weather.fogDensity;

    this.setTimeOfDay(this.hours);
    this._pushUniforms();
    this._bakeEnv();
  }

  /* ================================================================== */
  /* Shader                                                             */
  /* ================================================================== */

  _registerShader() {
    ShaderStore.ShadersStoreWGSL['owSkyVertexShader'] = /* wgsl */ `
      attribute position: vec3f;
      uniform worldViewProjection: mat4x4f;
      uniform world: mat4x4f;
      varying vWorld: vec3f;
      @vertex
      fn main(input: VertexInputs) -> FragmentInputs {
        vertexOutputs.position = uniforms.worldViewProjection * vec4f(input.position, 1.0);
        vertexOutputs.vWorld = (uniforms.world * vec4f(input.position, 1.0)).xyz;
      }
    `;

    ShaderStore.ShadersStoreWGSL['owSkyFragmentShader'] = /* wgsl */ `
      varying vWorld: vec3f;
      uniform camPos: vec3f;
      uniform sunDir: vec3f;
      uniform moonDir: vec3f;
      /** [太陽光強度, 濁度, 月の明るさ, 未使用] */
      uniform skyParams: vec4f;

      ${WGSL_ATMOSPHERE}

      @fragment
      fn main(input: FragmentInputs) -> FragmentOutputs {
        let dir = normalize(input.vWorld - uniforms.camPos);
        // 観測点は地表 + カメラ高度。ビル屋上と地上で空の色が僅かに変わる
        // (物理的に正しい挙動)。
        let eye = vec3f(0.0, R_GROUND + 1.0 + max(0.0, uniforms.camPos.y), 0.0);

        var col = skyRadiance(eye, dir, uniforms.sunDir, uniforms.skyParams.x, uniforms.skyParams.y);
        col = col + sunDisc(dir, uniforms.sunDir, uniforms.skyParams.x * 8.0);
        // 月。昼は無視できるが、夜のショットでは主光源になる。
        col = col + sunDisc(dir, uniforms.moonDir, uniforms.skyParams.z * 0.6);

        // 8bit 量子化のバンディングを潰す。引数はピクセル座標。
        col = col + vec3f(dither(input.position.xy));

        fragmentOutputs.color = vec4f(col, 1.0);
      }
    `;
  }

  _makeSkyMaterial() {
    if (!this.webgpu) {
      /**
       * WebGL2 フォールバック。
       *
       * 大気シェーダは WGSL のみで書いてある (materials と同じ理由で GLSL と
       * 二重管理しない)。WebGL2 では単色の空になる。ゲームは動くが絵は平坦。
       */
      const m = new StandardMaterial('skyFlat', this.scene);
      m.emissiveColor = new Color3(0.35, 0.48, 0.72);
      m.disableLighting = true;
      return m;
    }

    return new ShaderMaterial(
      'skyMat',
      this.scene,
      { vertex: 'owSky', fragment: 'owSky' },
      {
        attributes: ['position'],
        uniforms: ['worldViewProjection', 'world', 'camPos', 'sunDir', 'moonDir', 'skyParams'],
        shaderLanguage: ShaderLanguage.WGSL,
      }
    );
  }

  /* ================================================================== */
  /* Time of day                                                        */
  /* ================================================================== */

  /**
   * 時刻を設定する (0..24)。
   *
   * 環境マップの焼き直しを予約するので **毎フレーム呼ばないこと**。時間を連続的に
   * 進めたい場合は setTimeRate() を使う (内部で間引いて焼く)。
   */
  setTimeOfDay(hours) {
    this.hours = ((hours % 24) + 24) % 24;
    this._updateCelestial();
    this._envDirty = true;
    return this;
  }

  setTimeRate(hoursPerSecond) {
    this.timeRate = hoursPerSecond;
    return this;
  }

  setWeather(patch = {}) {
    Object.assign(this.weather, patch);
    this.scene.fogDensity = this.weather.fogDensity;
    this._envDirty = true;
    return this;
  }

  /**
   * 太陽・月の方向と光の強さを時刻から決める。
   *
   * 位置は celestial.js の球面天文学から取る (緯度 45N、夏至、日没 19.71 時)。
   * **簡易軌道で置き換えないこと** — dev/shots.js の時刻 (特に sunset=19.2) は
   * このモデルの太陽高度 (+4.6° = ゴールデンアワー) を前提に振られており、
   * 「日没 18 時」の sin カーブに簡略化した最初の移植では sunset ショットが
   * 真っ暗な夜空になった。
   */
  _updateCelestial() {
    const c = this.celestial.setHour(this.hours);
    const sunDir = c.sun;

    this.sunDir = sunDir;
    this.moonDir = c.moon;

    // DirectionalLight.direction は「光が進む向き」なので太陽方向の逆。
    this.sun.direction = sunDir.scale(-1);
    this.moon.direction = this.moonDir.scale(-1);

    /**
     * 明るさ。
     *
     * 太陽高度 0 (地平線) 付近で 0 になるが、**地平線直下でも即座に真っ暗にしない**
     * (-0.12 まで線形に落とす)。ここを 0 でクランプすると日没ショットが一瞬で夜に
     * 切り替わって不自然になる。
     */
    const up = sunDir.y;
    const day = clamp01((up + 0.12) / 0.32);
    this.sun.intensity = this.weather.sunIntensity * day;
    // 太陽が低いほど赤い (Rayleigh で青が抜けるため)。
    const warm = 1 - clamp01(up * 2.2);
    this.sun.diffuse = new Color3(1.0, 0.94 - warm * 0.3, 0.86 - warm * 0.55);

    const night = 1 - day;
    this.moon.intensity = 0.55 * night;
    this.moon.diffuse = new Color3(0.55, 0.62, 0.85);

    // 半球光も昼夜で振る。夜に昼の空色が残ると「暗いのに青い」不自然さが出る。
    this.ambient.intensity = 0.35 * day + 0.06 * night;
    this.ambient.diffuse = new Color3(
      0.55 * day + 0.1 * night,
      0.68 * day + 0.13 * night,
      0.9 * day + 0.22 * night
    );
  }

  _pushUniforms() {
    const mat = this.dome?.material;
    if (!mat?.setVector3) return; // フォールバックの StandardMaterial
    mat.setVector3('sunDir', this.sunDir);
    mat.setVector3('moonDir', this.moonDir);
    mat.setVector3('camPos', this.ctx.camera.globalPosition);
    /**
     * vec4f の uniform は **setVector4 で渡すこと**。setFloats は「float の配列」用で、
     * vec4f に使うと Babylon が配列 uniform として扱い
     * UniformBuffer.updateUniformArray の中で落ちる。
     */
    this._skyParams.set(
      this.weather.sunIntensity,
      this.weather.turbidity,
      this.moon.intensity,
      0
    );
    mat.setVector4('skyParams', this._skyParams);
  }

  /* ================================================================== */
  /* Environment                                                        */
  /* ================================================================== */

  /**
   * 空をキューブに焼いて IBL にする。
   *
   * SH の計算はキューブを CPU に読み戻すため **重い**。時刻が変わったときだけ呼ぶ。
   */
  _bakeEnv() {
    if (!this.probe) return;
    const cube = this.probe.cubeTexture;
    cube.refreshRate = 1;
    cube.render();
    cube.refreshRate = 0;

    /**
     * 拡散環境光の球面調和 (SH) を **空モデルから直接構築する**。
     *
     * ## なぜプローブから読み戻さないのか
     *
     * 最初は CubeMapToSphericalPolynomialTools でプローブのキューブから SH を
     * 計算していたが、WebGPU では RenderTargetTexture の同期読み戻しができず
     * null が返る。そして PBR 側は **反射テクスチャがキューブなら SH を使うと
     * 決め打つ** (materialHelper.functions.js の「Assume using spherical polynomial
     * if the reflection texture is a cube map」)。結果、描画のたびに
     * BindIBLParameters が polynomials.l00 を読もうとして落ちる。
     *
     * 大気モデルは CPU 側でも安く評価できるので、方向をサンプリングして SH に
     * 積む方が確実で速い。読み戻しも非同期待ちも要らない。
     *
     * ## サンプリング数について
     *
     * SH の 2 次までしか使わないので、方向は 64 本もあれば十分に滑らかになる。
     * これは「解像度」ではなく「低次の積分精度」の問題で、増やしても拡散光は
     * ほとんど変わらない。
     */
    const sh = new SphericalHarmonics();
    const N = 64;
    // フィボナッチ球で方向を均等に散らす。格子状に取ると極が密になる。
    const golden = Math.PI * (3 - Math.sqrt(5));
    const dOmega = (4 * Math.PI) / N;
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      const dir = new Vector3(Math.cos(th) * r, y, Math.sin(th) * r);
      const c = this._skyColorFor(dir);
      sh.addLight(dir, c, dOmega);
    }
    // レンダリング用のスケーリング (Babylon の規約に合わせる)。
    sh.preScaleForRendering();
    cube.sphericalPolynomial = SphericalPolynomial.FromHarmonics(sh);

    this._envDirty = false;
  }

  /**
   * 指定方向の空の色を CPU 側で概算する。SH の構築にだけ使う。
   *
   * シェーダの積分を再現するのではなく「上は空色、下は地面の反射、太陽の側は
   * 暖かい」という 3 要素の合成で近似する。拡散環境光は方向の低周波成分しか
   * 使わないので、この程度の近似で見た目は破綻しない。
   */
  _skyColorFor(dir) {
    const up = this.sunDir?.y ?? 0.5;
    const day = clamp01((up + 0.12) / 0.32);
    const horizon = this._horizonColor();
    // 天頂は地平線より青く暗い。
    const zenith = new Color3(horizon.r * 0.55, horizon.g * 0.72, horizon.b * 1.15);
    const t = clamp01(dir.y * 0.5 + 0.5);
    // 地面からの照り返し。砂の街なので暖色。
    const ground = new Color3(0.16 * day + 0.01, 0.13 * day + 0.01, 0.09 * day + 0.012);

    const skyMix = new Color3(
      horizon.r + (zenith.r - horizon.r) * Math.max(0, dir.y),
      horizon.g + (zenith.g - horizon.g) * Math.max(0, dir.y),
      horizon.b + (zenith.b - horizon.b) * Math.max(0, dir.y)
    );
    const c = new Color3(
      ground.r + (skyMix.r - ground.r) * t,
      ground.g + (skyMix.g - ground.g) * t,
      ground.b + (skyMix.b - ground.b) * t
    );

    // 太陽の側は明るく暖かい。太陽そのものは DirectionalLight が担うので、
    // ここでは周囲のハロぶんだけ足す。
    // (スケールは最後にまとめて掛ける — ハロも同じ単位系に乗せるため)
    if (this.sunDir) {
      const mu = Math.max(0, Vector3.Dot(dir, this.sunDir));
      const halo = mu ** 8 * 0.9 * day;
      c.r += halo * 1.0;
      c.g += halo * 0.82;
      c.b += halo * 0.6;
    }

    /**
     * **太陽と同じ単位系に乗せる。** 詳細は DEFAULT_WEATHER.skyIrradiance のコメント。
     * ここを掛け忘れると日陰が真っ黒になり、露出で持ち上げようとして空が白飛びする。
     */
    const k = this.weather.skyIrradiance;
    c.r *= k;
    c.g *= k;
    c.b *= k;
    return c;
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  update(dt, ctx) {
    if (this.timeRate !== 0) {
      this.hours = (this.hours + this.timeRate * dt) % 24;
      this._updateCelestial();
      // 連続で時間を進めるときは環境マップを間引いて焼く。0.25 時 (=15 分) 進んだら
      // 焼き直す。毎フレーム焼くと 6 面ぶんの描画が乗り、TAA の収束も壊れる。
      this._envAccum += Math.abs(this.timeRate * dt);
      if (this._envAccum > 0.25) {
        this._envAccum = 0;
        this._envDirty = true;
      }
    }

    // 空ドームはカメラに追従させる。しないと街の端でドームの縫い目が視界に入る。
    if (this.dome) this.dome.position.copyFrom(ctx.camera.globalPosition);
    this._pushUniforms();

    // フォグ色を地平線の空色に合わせる。ズレると遠景が板に見える。
    this.scene.fogColor = this._horizonColor();

    if (this._envDirty) this._bakeEnv();
  }

  /**
   * 地平線付近の空の色を CPU 側で概算する。
   *
   * シェーダと同じ積分を回すのは高いので太陽高度から経験的に作る。**フォグ色にしか
   * 使わない**ため、空ドームの実色と数 % ずれても絵は破綻しない。
   */
  _horizonColor() {
    const up = this.sunDir?.y ?? 0.5;
    const day = clamp01((up + 0.12) / 0.32);
    const warm = 1 - clamp01(up * 2.2);
    return new Color3(
      (0.52 + warm * 0.3) * day + 0.03,
      (0.6 - warm * 0.1) * day + 0.035,
      (0.72 - warm * 0.34) * day + 0.055
    );
  }

  /** 太陽の方向 (地上 → 太陽)。fx の god ray や ai の逆光判定が使う。 */
  sunDirection() {
    return this.sunDir;
  }

  dispose() {
    this.probe?.dispose();
    this.dome?.dispose();
    this.sun?.dispose();
    this.moon?.dispose();
    this.ambient?.dispose();
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
