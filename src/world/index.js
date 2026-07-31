import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';

import { WorldBuilder } from './builder.js';
import { STREET, ALLEYS, BUILDINGS, GATE, SET_PIECES } from './layout.js';

/**
 * WORLD — 中東の市場通り。約 120x120 m。
 *
 * ## 構成
 *
 *   - アスファルトの本通り (-Z 方向に伸びる) と両脇の歩道
 *   - 路地・中庭 (ALLEYS)
 *   - 建物 10 棟 (BUILDINGS)。壁・窓・屋根・バルコニー
 *   - 遠景を締めるアーチ門 (GATE)
 *   - 市場の屋台、バリア、土嚢、廃車、ヤシ、街灯、瓦礫、電線 (SET_PIECES)
 *
 * レイアウトのデータ (layout.js / palette.js = 842 行) は Three.js 版からそのまま
 * 再利用している。どちらも純粋なデータで描画ライブラリに依存していなかったため、
 * 移植で失われるものが無い。**この 842 行は移植対象ではなく資産**。
 *
 * ## 実用光源 (practicals) について
 *
 * 街灯や窓明かりは PointLight で置き `render.addLight()` に登録する。
 *
 * Three 版はここに `_stabiliseLightCount` という仕掛けを持っていた: 可視ライト数が
 * シェーダの permutation key になるため、ランプ 1 個が減衰半径を跨ぐだけで全マテリアル
 * が再コンパイルされ 640〜900ms のスパイクを出す、という問題への対処だった。
 *
 * **Babylon の clustered lighting ではこの問題が発生しない**ので、バラストライトも
 * 可視数の固定も不要になった。ライトはただ置くだけでよい (詳細は render/index.js)。
 */
/**
 * LEVEL→WORLD 変換。**値は Three 版 (main ブランチ) からそのまま引き継ぐこと。**
 *
 * layout.js は「通りが -Z に走る LEVEL 空間」で書かれている。一方、カメラショット
 * (dev/shots.js)・スポーン・AI の配置は「この yaw で回転済みの WORLD 空間」で
 * 書かれている。この変換が無いと hero カメラ (12,1.75,18) は東側の建物の**内部**に
 * 埋まり、「空が真っ黒 / 世界が屋内に見える」という一見シェーダ起因に見える壊れ方を
 * する (実際にこの移植で数時間を溶かした)。値を変えると全ショットの構図と全
 * スポーンが同時にずれるので、絶対に単独でいじらないこと。
 */
const LEVEL_YAW = 0.5877;
const LEVEL_TX = 0.9;
const LEVEL_TZ = 1.34;

export class WorldSystem {
  static id = 'world';
  static deps = ['materials', 'physics', 'render'];

  constructor() {
    /** 統合済みのワールドメッシュ。 */
    this.meshes = [];
    /** 実用光源。 */
    this.lights = [];
    /** 街灯の灯具位置。_buildSetPieces が埋める。 */
    this.lampHeads = [];
    /** プレイヤーのスポーン地点。 */
    this.spawns = [
      { position: new Vector3(12, 1.8, 18), yaw: -2.35 },
      { position: new Vector3(-2, 1.8, -30), yaw: 0.2 },
    ];
  }

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    const materials = ctx.get('materials');
    const physics = ctx.get('physics');
    const render = ctx.get('render');

    const b = new WorldBuilder(ctx.scene, materials);
    this.builder = b;
    // LEVEL 空間のレイアウトを WORLD 空間へ。push より前に設定すること (builder 参照)。
    b.setTransform(LEVEL_YAW, LEVEL_TX, LEVEL_TZ);

    this._buildGround(b);
    this._buildAlleys(b);
    for (const def of BUILDINGS) this._buildBuilding(b, def);
    this._buildGate(b);
    this._buildSetPieces(b);

    this.meshes = b.finish();

    // 物理と影に登録する。統合済みなので登録は数十回で済む。
    for (const m of this.meshes) {
      if (!m.metadata?.owNoCollision) physics.addStatic(m, m.metadata?.owSurface);
      render.addShadowCaster(m, false);
    }

    this._addLights(render, ctx);

    console.info(`[world] ${this.meshes.length} merged meshes, ${this.lights.length} practicals`);
  }

  /* ================================================================== */
  /* Ground                                                             */
  /* ================================================================== */

  _buildGround(b) {
    const { halfWidth, kerb, walkH, zMin, zMax } = STREET;
    const len = zMax - zMin;
    const cz = (zMin + zMax) / 2;

    // 砂地のベース。街の外まで広げて、路地の隙間から地面の切れ目が見えないようにする。
    b.pushGround(0, -0.02, cz, 140, 140, 'sand', { name: 'ground_base', subdivisions: 8 });

    // アスファルトの車道。
    b.pushGround(0, 0, cz, halfWidth * 2, len, 'asphalt', { name: 'road' });

    // 轍。乾いた土埃が溜まって見えるよう僅かに色を変える。
    b.pushBox(-1.5, 0.004, cz, 1.1, 0.01, len, 'road_rut', { noCollision: true });
    b.pushBox(1.5, 0.004, cz, 1.1, 0.01, len, 'road_rut', { noCollision: true });

    // 歩道。車道より walkH だけ高い。
    for (const s of [-1, 1]) {
      const x = s * ((halfWidth + kerb) / 2);
      const w = kerb - halfWidth;
      b.pushBox(x, walkH / 2, cz, w, walkH, len, 'concrete', { name: `walk${s}` });
      // 縁石。車道側に一段の陰を作る。
      b.pushBox(s * halfWidth, walkH / 2, cz, 0.12, walkH + 0.01, len, 'concrete_dark');
    }

    // 建物際の砂の吹き溜まり。地面と壁の接合線を隠す。
    for (const s of [-1, 1]) {
      b.pushBox(s * (kerb - 0.35), walkH + 0.02, cz, 0.7, 0.05, len, 'dust_skirt', {
        noCollision: true,
        noShadow: true,
      });
    }
  }

  _buildAlleys(b) {
    for (const a of ALLEYS) {
      const [x0, z0, x1, z1] = a.rect;
      const key = a.surface === 'gravel' ? 'gravel' : 'dirt';
      b.pushGround(
        (x0 + x1) / 2,
        0.005,
        (z0 + z1) / 2,
        Math.abs(x1 - x0),
        Math.abs(z1 - z0),
        key
      );
    }
  }

  /* ================================================================== */
  /* Buildings                                                          */
  /* ================================================================== */

  /**
   * 建物 1 棟。
   *
   * 壁は「実際に厚みのある 4 枚の板」として作る。README にある通り内部に入れることが
   * 要件なので、箱を 1 つ置くだけでは成立しない。
   */
  _buildBuilding(b, def) {
    const floorH = 3.1;
    const wallT = 0.32;
    const wallKey = def.wallKey ?? 'plaster_sand';
    const trimKey = def.trimKey ?? 'concrete';
    const { x, z } = def;

    for (let f = 0; f < def.floors; f++) {
      // セットバック: 上階が奥に下がる。単調な箱に見せないための造作。
      const inset = def.setback && f >= def.setback.from ? def.setback.depth : 0;
      const w = def.w - inset;
      const d = def.d - inset;
      const y0 = f * floorH;
      const cy = y0 + floorH / 2;
      const ox = inset && def.setback.side & 1 ? inset / 2 : 0;

      // 床スラブ。
      b.pushBox(x + ox, y0 + 0.09, z, w, 0.18, d, f === 0 ? 'floor_concrete' : 'concrete');
      this._buildWalls(b, x + ox, cy, z, w, d, floorH, wallT, wallKey, def, f);
    }

    // 屋根 + パラペット。
    const topY = def.floors * floorH;
    const inset = def.setback ? def.setback.depth : 0;
    const rw = def.w - inset;
    const rd = def.d - inset;
    const ox = inset && def.setback.side & 1 ? inset / 2 : 0;
    b.pushBox(x + ox, topY + 0.1, z, rw, 0.2, rd, 'roof_screed');
    const pH = 0.62;
    for (const [dx, dz, pw, pd] of [
      [0, rd / 2, rw, 0.22],
      [0, -rd / 2, rw, 0.22],
      [rw / 2, 0, 0.22, rd],
      [-rw / 2, 0, 0.22, rd],
    ]) {
      b.pushBox(x + ox + dx, topY + 0.2 + pH / 2, z + dz, pw, pH, pd, trimKey);
    }

    // 屋上設備。シルエットを崩すためのもの。
    for (let i = 0; i < (def.roofProps ?? 0); i++) {
      const px = x + ox + this.rng.range(-rw / 2 + 0.8, rw / 2 - 0.8);
      const pz = z + this.rng.range(-rd / 2 + 0.8, rd / 2 - 0.8);
      if (this.rng.float() < 0.5) {
        b.pushCylinder(px, topY + 0.7, pz, 1.0, 1.0, 'metal_rust_prop');
      } else {
        b.pushBox(px, topY + 0.55, pz, 0.9, 0.7, 0.7, 'metal_dark');
      }
    }

    // バルコニー。
    if (def.balconies) {
      for (let f = 1; f < def.floors; f++) {
        if (this.rng.float() > def.balconies) continue;
        const s = def.streetSide === 1 ? 1 : -1;
        const by = f * floorH + 0.12;
        const bz = z + s * (def.d / 2 + 0.5);
        b.pushBox(x, by, bz, 2.4, 0.14, 1.0, trimKey);
        b.pushBox(x, by + 0.5, bz + s * 0.45, 2.4, 0.9, 0.08, 'metal_rust');
      }
    }
  }

  /**
   * 4 面の壁を建てる。通りに面した壁だけ「腰壁 + 窓台 + 窓 + 楣上」に割る。
   *
   * 窓を「穴」ではなく分割で表現するのは CSG のブーリアンを避けるため。ブーリアンは
   * 頂点数が跳ね上がるうえ、統合後のメッシュで法線が壊れやすい。
   */
  _buildWalls(b, x, cy, z, w, d, floorH, t, wallKey, def, floor) {
    const sillH = 0.95;
    const winH = 1.35;
    const headH = floorH - sillH - winH;
    // 面: 0=-Z, 1=+X, 2=+Z, 3=-X (layout.js の side 規約)
    const faces = [
      { len: w, cx: x, cz: z - d / 2 + t / 2, horiz: true },
      { len: d, cx: x + w / 2 - t / 2, cz: z, horiz: false },
      { len: w, cx: x, cz: z + d / 2 - t / 2, horiz: true },
      { len: d, cx: x - w / 2 + t / 2, cz: z, horiz: false },
    ];

    for (let s = 0; s < 4; s++) {
      const face = faces[s];
      const isStreet = s === def.streetSide || s === def.secondarySide;
      const bw = face.horiz ? face.len : t;
      const bd = face.horiz ? t : face.len;

      if (!isStreet) {
        // 通りに面していない壁は開口なしの一枚板。
        b.pushBox(face.cx, cy, face.cz, bw, floorH, bd, wallKey);
        continue;
      }

      // 1 階の通り側には出入口を空ける。
      if (floor === 0 && def.doorBays && def.doorBays[s] !== undefined) {
        const doorW = 1.3;
        const rest = (face.len - doorW) / 2;
        for (const sgn of [-1, 1]) {
          const off = sgn * (doorW / 2 + rest / 2);
          b.pushBox(
            face.horiz ? face.cx + off : face.cx,
            cy,
            face.horiz ? face.cz : face.cz + off,
            face.horiz ? rest : t,
            floorH,
            face.horiz ? t : rest,
            wallKey
          );
        }
        // 出入口の上の垂れ壁。
        b.pushBox(
          face.cx,
          cy - floorH / 2 + 2.1 + (floorH - 2.1) / 2,
          face.cz,
          face.horiz ? doorW : t,
          floorH - 2.1,
          face.horiz ? t : doorW,
          wallKey
        );
        continue;
      }

      // 腰壁。
      const sillY = cy - floorH / 2 + sillH / 2;
      b.pushBox(face.cx, sillY, face.cz, bw, sillH, bd, wallKey);
      // 窓台。
      b.pushBox(face.cx, sillY + sillH / 2 + 0.05, face.cz, bw, 0.1, bd + 0.06, 'concrete');
      /**
       * 窓ガラス。開口として抜かずガラス板で塞ぐ。
       * 抜くと室内が丸見えになり、10 棟ぶんの内装を全部作る羽目になる。
       */
      const winY = cy - floorH / 2 + sillH + winH / 2;
      b.pushBox(
        face.cx,
        winY,
        face.cz,
        face.horiz ? bw * 0.86 : 0.04,
        winH,
        face.horiz ? 0.04 : bd * 0.86,
        'glass',
        { noShadow: true }
      );
      // 窓枠の縦桟。
      b.pushBox(face.cx, winY, face.cz, face.horiz ? 0.07 : t, winH, face.horiz ? t : 0.07, 'wood_dark');
      // 楣より上の壁。
      b.pushBox(face.cx, cy + floorH / 2 - headH / 2, face.cz, bw, headH, bd, wallKey);
    }
  }

  /* ================================================================== */
  /* Gate                                                               */
  /* ================================================================== */

  /**
   * 遠景を締めるアーチ門。
   *
   * layout.js の GATE には「なぜこの形なのか」が詳しく書かれている (16:30 の太陽が
   * -X/-Z 象限にあるため、塔を手前に出すと西側の returns が順光になり、隣の日陰面と
   * 2 段の明度差ができる)。**その意図を壊さないよう寸法はそのまま使う。**
   */
  _buildGate(b) {
    const g = GATE;
    const key = 'concrete';
    b.pushBox((g.xL0 + g.xL1) / 2, g.hL / 2, g.z, g.xL1 - g.xL0, g.hL, g.depth, key);
    b.pushBox(
      (g.xR0 + g.xR1) / 2,
      g.hR / 2,
      g.z - g.eastProud / 2,
      g.xR1 - g.xR0,
      g.hR,
      g.depth + g.eastProud,
      key
    );
    b.pushBox(
      (g.xT0 + g.xT1) / 2,
      g.hT / 2,
      g.z - g.towerProud / 2,
      g.xT1 - g.xT0,
      g.hT,
      g.depth + g.towerProud,
      key
    );

    // アーチ。半円を短冊で近似する (CSG を避ける理由は _buildWalls と同じ)。
    const steps = 12;
    const r = g.span / 2;
    const cx = (g.xL1 + g.xR0) / 2;
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI;
      const a1 = ((i + 1) / steps) * Math.PI;
      const y0 = g.height - r + Math.sin(a0) * r;
      const y1 = g.height - r + Math.sin(a1) * r;
      const x0 = cx + Math.cos(a0) * r;
      const x1 = cx + Math.cos(a1) * r;
      const seg = Math.hypot(x1 - x0, y1 - y0);
      const mesh = b.pushBox((x0 + x1) / 2, (y0 + y1) / 2 + 0.35, g.z, seg, 0.7, g.depth, key);
      mesh.rotation.z = Math.atan2(y1 - y0, x1 - x0);
    }
    // アーチ上の胴体。
    b.pushBox(cx, (g.height + g.bodyH) / 2 + 0.3, g.z, g.xR0 - g.xL1, g.bodyH - g.height, g.depth, key);
  }

  /* ================================================================== */
  /* Set pieces                                                         */
  /* ================================================================== */

  _buildSetPieces(b) {
    const S = SET_PIECES;

    // 市場の屋台。天板 + 4 本脚 + 日除け。市場らしさの大半はこの色布が担う。
    for (const [x, z, ry, w] of S.stalls) {
      b.pushBox(x, 0.9, z, w, 0.08, 1.2, 'wood_prop', { ry });
      for (const dx of [-w / 2 + 0.12, w / 2 - 0.12]) {
        for (const dz of [-0.5, 0.5]) {
          b.pushBox(
            x + dx * Math.cos(ry) - dz * Math.sin(ry),
            0.45,
            z + dx * Math.sin(ry) + dz * Math.cos(ry),
            0.07,
            0.9,
            0.07,
            'wood_prop_dark'
          );
        }
      }
      const cloth = this.rng.pick(['fabric_red', 'fabric_teal', 'fabric_cream']);
      b.pushBox(x, 2.05, z, w + 0.3, 0.04, 1.6, cloth, { ry });
      for (const dx of [-w / 2, w / 2]) {
        b.pushBox(x + dx * Math.cos(ry), 1.5, z + dx * Math.sin(ry), 0.05, 1.1, 0.05, 'wood_prop_dark');
      }
    }

    // ジャージーバリア。断面が台形なので 2 段の箱で近似する。
    for (const [x, z, ry] of S.jerseys) {
      b.pushBox(x, 0.28, z, 0.62, 0.56, 1.9, 'concrete_prop', { ry });
      b.pushBox(x, 0.72, z, 0.34, 0.34, 1.9, 'concrete_prop', { ry });
    }

    // 土嚢。1 袋ずつ積む。数が多いので統合前提。
    for (const [x, z, ry, len] of S.sandbagWalls) {
      const per = Math.max(2, Math.round(len / 0.42));
      for (let r = 0; r < 3; r++) {
        for (let i = 0; i < per; i++) {
          // 段ごとに半個ずらすと積んだ感じが出る。
          const off = (i - (per - 1) / 2) * 0.42 + (r % 2) * 0.21;
          b.pushBox(
            x + off * Math.cos(ry),
            0.11 + r * 0.2,
            z + off * Math.sin(ry),
            0.4,
            0.2,
            0.26,
            'burlap',
            { ry: ry + this.rng.range(-0.12, 0.12) }
          );
        }
      }
    }

    // 廃車。箱を組んで車らしいシルエットを作る。
    for (const [x, z, ry] of S.wrecks) {
      b.pushBox(x, 0.55, z, 1.8, 0.7, 4.2, 'metal_dark', { ry });
      b.pushBox(x, 1.15, z - 0.3, 1.7, 0.6, 2.0, 'metal_dark', { ry });
      for (const [dx, dz] of [
        [-0.85, 1.5],
        [0.85, 1.5],
        [-0.85, -1.5],
        [0.85, -1.5],
      ]) {
        b.pushCylinder(
          x + dx * Math.cos(ry) - dz * Math.sin(ry),
          0.32,
          z + dx * Math.sin(ry) + dz * Math.cos(ry),
          0.62,
          0.24,
          'rubber',
          { ry: ry + Math.PI / 2, sides: 12 }
        );
      }
    }

    // ヤシ。幹 + 葉。
    for (const [x, z, s] of S.palms) {
      const h = 5.2 * s;
      b.pushCylinder(x, h / 2, z, 0.34 * s, h, 'wood_dark', { sides: 10 });
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + this.rng.range(-0.2, 0.2);
        const len = 2.1 * s;
        const mesh = b.pushBox(
          x + Math.cos(a) * len * 0.45,
          h + 0.25,
          z + Math.sin(a) * len * 0.45,
          len,
          0.05,
          0.5 * s,
          'foliage',
          { ry: -a }
        );
        mesh.rotation.z = 0.28;
      }
    }

    // 街灯。灯具の位置を控えておき、後で PointLight を足す。
    for (const [x, z, ry] of S.lamps) {
      b.pushCylinder(x, 2.6, z, 0.16, 5.2, 'metal_dark', { sides: 10 });
      const armLen = 1.4;
      const hx = x + Math.cos(ry) * armLen;
      const hz = z + Math.sin(ry) * armLen;
      b.pushBox((x + hx) / 2, 5.15, (z + hz) / 2, armLen, 0.1, 0.1, 'metal_dark', { ry });
      b.pushBox(hx, 5.0, hz, 0.5, 0.16, 0.28, 'metal_dark', { ry });
      // 灯具位置はメッシュではないので LEVEL→WORLD を自分で通す (builder.toWorld 参照)。
      this.lampHeads.push(b.toWorld(hx, 4.86, hz));
    }

    // 瓦礫。小石を撒く。
    for (const [x, z, r, n] of S.rubble) {
      for (let i = 0; i < n; i++) {
        const a = this.rng.float() * Math.PI * 2;
        const rr = Math.sqrt(this.rng.float()) * r;
        const s = this.rng.range(0.12, 0.42);
        const mesh = b.pushBox(
          x + Math.cos(a) * rr,
          s * 0.4,
          z + Math.sin(a) * rr,
          s,
          s * 0.7,
          s * this.rng.range(0.7, 1.3),
          'concrete_prop',
          { ry: this.rng.float() * Math.PI }
        );
        mesh.rotation.x = this.rng.range(-0.3, 0.3);
        mesh.rotation.z = this.rng.range(-0.3, 0.3);
      }
    }

    // タイヤの山。
    for (const [x, z, n] of S.tyres) {
      for (let i = 0; i < n; i++) {
        b.pushCylinder(
          x + this.rng.range(-0.06, 0.06),
          0.11 + i * 0.2,
          z + this.rng.range(-0.06, 0.06),
          0.68,
          0.2,
          'rubber',
          { sides: 14 }
        );
      }
    }

    // ファサードの吊り布。
    for (const [x, y, z, ry, w, h] of S.hangings) {
      const cloth = this.rng.pick(['fabric_red', 'fabric_teal', 'fabric_cream']);
      b.pushBox(x, y, z, 0.04, h, w, cloth, { ry, noCollision: true });
    }

    // 洗濯物。線に沿って布を吊るす。
    for (const [x0, y0, z0, x1, y1, z1] of S.laundry) {
      const n = 5;
      for (let i = 1; i <= n; i++) {
        const t = i / (n + 1);
        // 線は中央でたるむ。
        const sag = Math.sin(t * Math.PI) * 0.18;
        const cloth = this.rng.pick(['fabric_cream', 'fabric_teal', 'fabric_red']);
        b.pushBox(
          x0 + (x1 - x0) * t,
          y0 + (y1 - y0) * t - sag - 0.35,
          z0 + (z1 - z0) * t,
          0.03,
          0.6,
          0.45,
          cloth,
          { noCollision: true, noShadow: true }
        );
      }
    }

    // 電線。たるみを短冊で近似する。
    for (const [x0, y0, z0, x1, y1, z1, sag] of S.cables) {
      const n = 8;
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const px = x0 + (x1 - x0) * t;
        const pz = z0 + (z1 - z0) * t;
        const py = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * sag;
        if (prev) {
          const len = Math.hypot(px - prev.px, py - prev.py, pz - prev.pz);
          const mesh = b.pushBox(
            (prev.px + px) / 2,
            (prev.py + py) / 2,
            (prev.pz + pz) / 2,
            len,
            0.035,
            0.035,
            'metal_dark',
            { ry: Math.atan2(-(pz - prev.pz), px - prev.px), noCollision: true, noShadow: true }
          );
          mesh.rotation.z = Math.asin((py - prev.py) / Math.max(len, 1e-4));
        }
        prev = { px, py, pz };
      }
    }
  }

  /* ================================================================== */
  /* Lights                                                             */
  /* ================================================================== */

  /**
   * 実用光源。
   *
   * Three 版はここで可視ライト数を固定する仕掛け (`_stabiliseLightCount`) を必要と
   * していたが、clustered lighting ではライトをただ置くだけでよい。詳細は
   * render/index.js の冒頭コメント。
   */
  _addLights(render, ctx) {
    // 街灯。夜だけ点く (強度は update で振る)。
    for (const p of this.lampHeads) {
      const l = new PointLight(`lamp_${p.x.toFixed(1)}_${p.z.toFixed(1)}`, p.clone(), ctx.scene);
      l.diffuse = new Color3(1.0, 0.82, 0.55);
      l.intensity = 0;
      l.range = 14;
      render.addLight(l);
      this.lights.push({ light: l, base: 22 });
    }

    // 窓明かり。1 階の通り側だけに置く。全窓に置くと夜景がのっぺりする。
    for (const def of BUILDINGS) {
      if (def.streetSide === undefined) continue;
      const s = def.streetSide === 1 ? 1 : -1;
      // def.x / def.z は LEVEL 空間 (layout.js) なので WORLD へ写してから置く。
      const l = new PointLight(
        `win_${def.id}`,
        this.builder.toWorld(def.x, 2.2, def.z + s * (def.d / 2 + 0.6)),
        ctx.scene
      );
      l.diffuse = new Color3(1.0, 0.78, 0.5);
      l.intensity = 0;
      l.range = 8;
      render.addLight(l);
      this.lights.push({ light: l, base: 6 });
    }
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  update(dt, ctx) {
    // 夜間だけ実用光源を点ける。太陽高度から連続的に。
    const sky = ctx.peek('sky');
    if (!sky?.sunDir) return;
    const night = 1 - clamp01((sky.sunDir.y + 0.12) / 0.32);
    for (const e of this.lights) e.light.intensity = e.base * night;
  }

  /** スポーン地点。player が使う。 */
  spawn(i = 0) {
    return this.spawns[i % this.spawns.length];
  }

  /** (x,z) の地面高さ。ai の経路計算が使う。 */
  groundHeight(x, z) {
    return this.ctx.get('physics').groundHeight(x, z);
  }

  dispose() {
    for (const e of this.lights) e.light.dispose();
    for (const m of this.meshes) m.dispose();
    this.lights.length = 0;
    this.meshes.length = 0;
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export { STREET, BUILDINGS, GATE, SET_PIECES };
