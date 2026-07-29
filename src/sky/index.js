import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ReflectionProbe } from '@babylonjs/core/Probes/reflectionProbe.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { CubeMapToSphericalPolynomialTools } from '@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial.js';

import { WGSL_ATMOSPHERE } from './wgsl/atmosphere.js';

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
    this._envDirty = true;
    this._envAccum = 0;
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
   * 太陽は東 (+X) から昇り西 (-X) に沈む。季節や緯度は入れていない — このゲームは
   * 1 つの街の 1 日しか描かないので、少し傾けた円軌道で十分。
   */
  _updateCelestial() {
    // 6:00 に日の出、18:00 に日没となる位相。
    const t = ((this.hours - 6) / 12) * Math.PI;
    // 真上を通らないよう南に傾ける。影が伸びて絵になる。
    const tilt = 0.34;
    const sunDir = new Vector3(
      Math.cos(t),
      Math.sin(t),
      Math.sin(t) * -tilt + Math.cos(t) * 0.12
    ).normalize();

    this.sunDir = sunDir;
    this.moonDir = sunDir.scale(-1);

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
    mat.setFloats('skyParams', [
      this.weather.sunIntensity,
      this.weather.turbidity,
      this.moon.intensity,
      0,
    ]);
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
     * 拡散環境光用の SH を作り直す。
     *
     * これが無いと Babylon は環境キューブの最下位ミップで拡散を近似する。絵は出るが
     * 日没時に「空は赤いのに物体は青いまま」という破綻が出る。SH なら方向ごとの色が
     * 正しく効く。
     *
     * 失敗しても致命的ではない (拡散がやや不正確になるだけ) ので握り潰す。ここで
     * 例外を投げて起動を止めるほうが害が大きい。
     */
    try {
      const sp = CubeMapToSphericalPolynomialTools.ConvertCubeMapTextureToSphericalPolynomial(cube);
      if (sp) cube.sphericalPolynomial = sp;
    } catch (err) {
      console.warn('[sky] SH 生成に失敗しました (拡散環境光がやや不正確になります):', err);
    }
    this._envDirty = false;
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
