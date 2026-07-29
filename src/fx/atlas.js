import { ProceduralTexture } from '@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';

import { WGSL_PARTICLE_ATLAS, WGSL_DECAL_ATLAS } from './wgsl/atlas.js';

/**
 * FX のテクスチャはすべてここで、起動時に 1 回だけ焼かれる。
 * このプロジェクトに画像ファイルは 1 枚も存在しない (README の「no art assets」)。
 *
 * 2 枚のアトラス:
 *   PARTICLES  RGB = 模様 (粒子ごとの色に掛かる)、A = 被覆率
 *   DECALS     RGB = 模様、A = 被覆率
 *
 * どちらも 4x4。タイル ID は下の P / D と wgsl/atlas.js の分岐が **1 対 1 で対応**して
 * いる。片方だけ足すと黙って別の絵が出るので、必ず両方を同時に編集すること。
 */

// ---------------------------------------------------------------------------
//  パーティクルアトラスの配置 (4x4)
// ---------------------------------------------------------------------------
export const P = {
  SMOKE_A: 0,
  SMOKE_B: 1,
  WISP: 2,
  DUST: 3,
  SPARK: 4,
  STREAK: 5,
  FLASH_LOBE: 6,
  FLASH_CORE: 7,
  CHIP: 8,
  SPLINTER: 9,
  DROPLET: 10,
  MIST: 11,
  SPLASH: 12,
  RING: 13,
  FIRE: 14,
  MOTE: 15,
};

// ---------------------------------------------------------------------------
//  デカールアトラスの配置 (4x4)
// ---------------------------------------------------------------------------
export const D = {
  HOLE_CONCRETE: 0,
  HOLE_CONCRETE_B: 1,
  HOLE_METAL: 2,
  HOLE_WOOD: 3,
  HOLE_PLASTER: 4,
  GLASS_CRACK: 5,
  BLOOD_A: 6,
  BLOOD_B: 7,
  SCORCH: 8,
  IMPACT_DIRT: 9,
  IMPACT_SAND: 10,
  SCRAPE: 11,
  RIPPLE: 12,
  HOLE_GLASS: 13,
  SMUDGE: 14,
  TEAR: 15,
};

/** どちらのアトラスも 4 列。particles.js の uAtlas に渡る。 */
export const ATLAS_COLS = 4;

/**
 * アトラスを 2 枚焼く。
 *
 * WebGPU でない場合は null を返す (materials と同じ方針で WGSL のみ保守する)。
 * 呼び出し側は null を受けたら FX を無効化すること — **黙って真っ黒なスプライトを
 * 描かないこと**。
 */
export async function bakeAtlases(scene, backend, size = 512) {
  if (backend !== 'webgpu') {
    console.warn('[fx] WebGPU でないためスプライトアトラスを生成できません。FX を無効化します。');
    return null;
  }

  const particles = await bakeOne(scene, 'fxParticleAtlas', WGSL_PARTICLE_ATLAS, size, 7717);
  const decals = await bakeOne(scene, 'fxDecalAtlas', WGSL_DECAL_ATLAS, size, 4409);
  return { particles, decals, cols: ATLAS_COLS };
}

async function bakeOne(scene, name, source, size, seed) {
  const pt = new ProceduralTexture(
    name,
    size,
    { fragmentSource: source },
    scene,
    {
      shaderLanguage: ShaderLanguage.WGSL,
      skipSceneRegistration: true,
      generateMipMaps: true,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
    },
    true
  );
  pt.setFloat('seedf', seed);
  /**
   * **タイル境界での滲みを防ぐため CLAMP にする。**
   *
   * 4x4 のタイルを 1 枚のテクスチャに詰めているので、WRAP のままだと隣のタイルの
   * 端が滲み込む。煙のタイルに火花の芯が薄く混ざる、という気付きにくい壊れ方をする。
   */
  pt.wrapU = Texture.CLAMP_ADDRESSMODE;
  pt.wrapV = Texture.CLAMP_ADDRESSMODE;
  /**
   * 模様は **線形**として扱う。粒子の色は spawn 側が線形で決めており、アトラスは
   * それに掛かる係数でしかない。sRGB 解釈させるとガンマ 2.2 ぶんずれる。
   */
  pt.gammaSpace = false;
  pt.hasAlpha = true;

  await whenReady(pt, name);
  pt.render();
  return pt;
}

/**
 * effect のコンパイル完了を待つ。
 *
 * `isReady()` は初回呼び出しで effect の生成を開始する副作用を持つので、ポーリング
 * すること自体がトリガーになる。タイムアウトを持たせるのは、WGSL のコンパイルエラー時に
 * 永遠に false が返り **無言でハングする**ため。どのアトラスで落ちたか名前付きで
 * 投げた方が原因に辿り着ける (materials/index.js の bake() と同じ理由)。
 */
function whenReady(pt, name, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      if (pt.isReady()) return resolve(pt);
      if (performance.now() - t0 > timeoutMs) {
        return reject(
          new Error(`[fx] "${name}" のシェーダが ${timeoutMs}ms 以内に ready にならなかった (WGSL コンパイルエラーの可能性)`)
        );
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}
