/**
 * SURFACE LIBRARY — 19 種の手続きサーフェスの定義。
 *
 * ここには **数値しか置かない**。生成ロジックは wgsl/surface.js に一本化されて
 * いるので、新しいサーフェスを足す作業は多くの場合このファイルに 1 エントリ
 * 足すだけで済む (SSOT)。
 *
 * 各エントリ:
 *   kind      wgsl/surface.js の分岐 ID。KIND を使うこと (生の数字を書かない)
 *   surface   ARCHITECTURE.md の 12 種 physics/FX 語彙。decal・足音・弾痕が参照する
 *   bake      size    生成解像度 (px)
 *             world   タイル 1 枚が実世界で覆う長さ (m)。テクセル密度を決める
 *             relief  凹凸の山谷差 (m)。法線の勾配はこれと world から決まる
 *             tile    タイル内の格子分割数。**周期性の基準**なので整数であること
 *             seed    ハッシュ種
 *             pa/pb   kind 固有パラメータ (意味は surface.js の該当分岐を参照)
 *   colors    tint / tint2 / grime。**sRGB の 0xRRGGBB で書く** (人間が読めるように)。
 *             線形化は materials/index.js が行うので、ここに線形値を書かないこと
 *   weather   [全体強度, エッジ摩耗, 凹部の汚れ, 色ムラ]
 *   orm       [roughness 基準, height→roughness 傾き, AO 強度, metallic]
 *
 * ## albedo の値域について
 *
 * README の品質バーに「Albedo in 0.02-0.9, metals are 0 or 1」とある。ここの色は
 * すべてその範囲に収まるよう選んである。**物理的にありえない暗さ/明るさに逃がして
 * 露出を誤魔化さないこと** — Three 版で武器の albedo を 1/3 に潰して破綻した経緯が
 * README に記録されている。
 */

/** wgsl/surface.js の分岐 ID。生の数字をライブラリに書かないための SSOT。 */
export const KIND = {
  CONCRETE: 0,
  BRICK: 1,
  PLASTER: 2,
  TILE: 3,
  ASPHALT: 4,
  SAND: 5,
  DIRT: 6,
  GRAVEL: 7,
  METAL_RUST: 8,
  METAL_PAINTED: 9,
  METAL_BRUSHED: 10,
  CORRUGATED: 11,
  WOOD: 12,
  FABRIC: 13,
  BURLAP: 14,
  FOLIAGE: 15,
  RUBBER: 16,
  GLASS: 17,
};

/** sRGB 0xRRGGBB → 線形 [r,g,b]。PBR の albedo は線形でなければならない。 */
export function hexToLinear(hex) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

export const LIBRARY = {
  // ---------------------------------------------------------------- 石材 --
  concrete: {
    kind: KIND.CONCRETE,
    surface: 'concrete',
    bake: { size: 1024, world: 2.5, relief: 0.09, tile: 4, seed: 11, pa: [0, 0, 0, 0] },
    colors: { tint: 0x8e8b84, tint2: 0x757169, grime: 0x2b2823 },
    weather: [0.42, 0.4, 0.55, 0.5],
    orm: [0.92, 0.16, 0.85, 0],
  },
  concrete_floor: {
    kind: KIND.CONCRETE,
    surface: 'concrete',
    // pa.x=1 で打ち継ぎの帯を消す (床には出ないため)。
    bake: { size: 1024, world: 3.2, relief: 0.06, tile: 4, seed: 47, pa: [1, 0, 0, 0] },
    colors: { tint: 0x8a877f, tint2: 0x6f6b63, grime: 0x272420 },
    weather: [0.55, 0.1, 0.62, 0.42],
    orm: [0.95, 0.12, 0.9, 0],
  },
  brick: {
    kind: KIND.BRICK,
    surface: 'concrete',
    // pa = [列数, 段数, 目地幅, 段ごとのずらし]
    bake: { size: 1024, world: 1.35, relief: 0.055, tile: 4, seed: 23, pa: [6, 16, 0.035, 0.5] },
    colors: { tint: 0x9c5f45, tint2: 0x7a4632, grime: 0x8b8578 },
    weather: [0.5, 0.35, 0.6, 0.55],
    orm: [0.88, 0.2, 0.95, 0],
  },
  plaster: {
    kind: KIND.PLASTER,
    surface: 'plaster',
    // pa = [剥離しきい値, 剥離の深さ, -, -]
    bake: { size: 1024, world: 2.8, relief: 0.05, tile: 4, seed: 71, pa: [0.62, 0.55, 0, 0] },
    colors: { tint: 0xc4bba6, tint2: 0x9a5f45, grime: 0x6e6455 },
    weather: [0.6, 0.5, 0.5, 0.5],
    orm: [0.9, 0.14, 0.8, 0],
  },
  tile: {
    kind: KIND.TILE,
    surface: 'concrete',
    // pa = [1 辺のタイル数, 目地幅, -, -]
    bake: { size: 1024, world: 1.2, relief: 0.02, tile: 4, seed: 89, pa: [8, 0.03, 0, 0] },
    colors: { tint: 0xa8a294, tint2: 0x8d8578, grime: 0x4a453c },
    weather: [0.35, 0.2, 0.7, 0.3],
    orm: [0.42, -0.22, 0.75, 0],
  },

  // ---------------------------------------------------------------- 地面 --
  asphalt: {
    kind: KIND.ASPHALT,
    surface: 'concrete',
    // pa = [ひび幅, ひびしきい値, -, -]
    bake: { size: 1024, world: 3.0, relief: 0.045, tile: 4, seed: 5, pa: [0.05, 0.62, 0, 0] },
    colors: { tint: 0x3d3b38, tint2: 0x56534d, grime: 0x232120 },
    weather: [0.5, 0.25, 0.5, 0.4],
    orm: [0.94, 0.1, 0.85, 0],
  },
  sand: {
    kind: KIND.SAND,
    surface: 'sand',
    // pa = [風紋の周波数, 風紋の振幅, 風紋の向き(rad), -]
    bake: { size: 1024, world: 4.0, relief: 0.05, tile: 4, seed: 13, pa: [3, 0.055, 0.7, 0] },
    colors: { tint: 0xc2a878, tint2: 0xa78d5f, grime: 0x6d5c3f },
    weather: [0.3, 0.05, 0.25, 0.45],
    orm: [0.97, 0.06, 0.6, 0],
  },
  dirt: {
    kind: KIND.DIRT,
    surface: 'dirt',
    // pa = [乾裂の深さ, -, -, -]
    bake: { size: 1024, world: 3.2, relief: 0.07, tile: 4, seed: 29, pa: [0.16, 0, 0, 0] },
    colors: { tint: 0x6b5a44, tint2: 0x53442f, grime: 0x342b1e },
    weather: [0.5, 0.15, 0.6, 0.5],
    orm: [0.96, 0.08, 0.9, 0],
  },
  gravel: {
    kind: KIND.GRAVEL,
    surface: 'dirt',
    // pa = [石の密度 (voronoi 格子数), -, -, -]
    bake: { size: 1024, world: 2.0, relief: 0.1, tile: 4, seed: 37, pa: [16, 0, 0, 0] },
    colors: { tint: 0x8a8074, tint2: 0x6b6157, grime: 0x3a342c },
    weather: [0.4, 0.1, 0.55, 0.5],
    orm: [0.93, 0.12, 0.95, 0],
  },

  // ---------------------------------------------------------------- 金属 --
  metal_rust: {
    kind: KIND.METAL_RUST,
    surface: 'metal',
    // pa = [錆のしきい値, 錆の量, -, -]
    bake: { size: 1024, world: 1.6, relief: 0.02, tile: 4, seed: 53, pa: [0.48, 0.9, 0, 0] },
    colors: { tint: 0x6e6a66, tint2: 0x8a4a26, grime: 0x2a2320 },
    weather: [0.6, 0.5, 0.5, 0.4],
    // 錆は非金属なので metallic を落とす。健全部との差はシェーダ側の色で出す。
    orm: [0.72, 0.3, 0.85, 0.35],
  },
  metal_painted: {
    kind: KIND.METAL_PAINTED,
    surface: 'metal',
    // pa = [塗装剥げの量, -, -, -]
    bake: { size: 1024, world: 1.8, relief: 0.012, tile: 4, seed: 61, pa: [0.55, 0, 0, 0] },
    colors: { tint: 0x3f5a6b, tint2: 0x7a7570, grime: 0x22201e },
    weather: [0.45, 0.6, 0.4, 0.3],
    orm: [0.48, -0.16, 0.7, 0.15],
  },
  metal_brushed: {
    kind: KIND.METAL_BRUSHED,
    surface: 'metal',
    // pa = [刷毛目の伸長率, -, 向き(rad), -]
    bake: { size: 1024, world: 1.0, relief: 0.004, tile: 4, seed: 67, pa: [140, 0, 0.15, 0] },
    colors: { tint: 0x9a9a9e, tint2: 0x76767a, grime: 0x2a2a2c },
    weather: [0.2, 0.15, 0.3, 0.2],
    // 金属は metallic=1。README の「metals are 0 or 1」に従う。
    orm: [0.34, -0.14, 0.5, 1.0],
  },
  corrugated: {
    kind: KIND.CORRUGATED,
    surface: 'metal',
    // pa = [波の本数 (整数), 錆の量, -, -]
    bake: { size: 1024, world: 2.2, relief: 0.05, tile: 4, seed: 73, pa: [10, 0.55, 0, 0] },
    colors: { tint: 0x8d8b85, tint2: 0x8a4f2c, grime: 0x2b2622 },
    weather: [0.55, 0.4, 0.5, 0.4],
    orm: [0.62, 0.24, 0.75, 0.55],
  },

  // ---------------------------------------------------------- 木・有機物 --
  wood: {
    kind: KIND.WOOD,
    surface: 'wood',
    // pa = [年輪の詰まり, 節の密度, 木目の向き(rad), -]
    bake: { size: 1024, world: 1.6, relief: 0.03, tile: 4, seed: 83, pa: [7, 3, 0.12, 0] },
    colors: { tint: 0x8a6540, tint2: 0x5c412a, grime: 0x2e251b },
    weather: [0.5, 0.35, 0.55, 0.45],
    orm: [0.82, 0.2, 0.85, 0],
  },
  fabric: {
    kind: KIND.FABRIC,
    surface: 'fabric',
    // pa = [織り目の数, -, -, -]
    bake: { size: 512, world: 0.8, relief: 0.006, tile: 4, seed: 97, pa: [42, 0, 0, 0] },
    colors: { tint: 0x7a6f5e, tint2: 0x5f5647, grime: 0x332d24 },
    weather: [0.35, 0.2, 0.45, 0.35],
    orm: [0.94, 0.06, 0.8, 0],
  },
  burlap: {
    kind: KIND.BURLAP,
    surface: 'fabric',
    bake: { size: 512, world: 0.7, relief: 0.012, tile: 4, seed: 101, pa: [24, 0, 0, 0] },
    colors: { tint: 0x9c8560, tint2: 0x7b6746, grime: 0x413523 },
    weather: [0.45, 0.25, 0.6, 0.4],
    orm: [0.97, 0.05, 0.9, 0],
  },
  foliage: {
    kind: KIND.FOLIAGE,
    surface: 'foliage',
    // pa = [葉の密度, -, -, -]
    bake: { size: 512, world: 1.4, relief: 0.03, tile: 4, seed: 103, pa: [10, 0, 0, 0] },
    colors: { tint: 0x4a6b32, tint2: 0x6d8a3c, grime: 0x22301a },
    weather: [0.4, 0.1, 0.4, 0.6],
    orm: [0.72, 0.16, 0.9, 0],
  },
  rubber: {
    kind: KIND.RUBBER,
    surface: 'rubber',
    // pa = [ブロック数, ブロックの面取り幅, -, -]
    bake: { size: 512, world: 0.9, relief: 0.02, tile: 4, seed: 107, pa: [7, 0.09, 0, 0] },
    colors: { tint: 0x2a2a2c, tint2: 0x1e1e20, grime: 0x141414 },
    weather: [0.3, 0.15, 0.4, 0.2],
    orm: [0.88, 0.1, 0.8, 0],
  },
  glass: {
    kind: KIND.GLASS,
    surface: 'glass',
    // pa = [拭き跡の濃さ, 埃の濃さ, -, -]
    bake: { size: 512, world: 2.0, relief: 0.002, tile: 4, seed: 109, pa: [0.22, 0.18, 0, 0] },
    colors: { tint: 0xbfc9cc, tint2: 0xa9b4b8, grime: 0x6e7472 },
    weather: [0.25, 0.05, 0.2, 0.15],
    orm: [0.08, -0.04, 0.3, 0],
  },
};

export const SURFACE_KEYS = Object.keys(LIBRARY);
