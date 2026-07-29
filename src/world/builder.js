import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';

import { PALETTE } from './palette.js';

/**
 * WORLD / BUILDER — ジオメトリを積み上げ、マテリアルごとに 1 メッシュへ束ねる。
 *
 * ## なぜ「積んでから束ねる」のか
 *
 * この街は 10 棟の建物と数百のプロップでできている。1 プロップ = 1 メッシュのまま
 * 描くと draw call が数百本になり CPU 側で頭打ちになる。同じマテリアルを使う
 * ジオメトリを 1 本に統合すれば draw call はパレットのキー数 (数十) に落ちる。
 *
 * 代償は「個々のプロップを動かせなくなる」こと。壊れる/動くものは統合対象から外して
 * 個別メッシュのまま持つ (`solo: true`)。
 *
 * ## テクセル密度の統一
 *
 * Babylon の箱は面ごとに UV 0..1 を張るので、そのままだと 0.5m の箱も 12m の壁も
 * テクスチャが 1 枚ぶん貼られ、**大きい面ほどテクスチャが引き伸びる**。
 * `pushBox` は箱の実寸とマテリアルのタイル実寸から UV を焼き直し、どの面でも
 * 1 メートルあたりのテクセル数が揃うようにする。これをやらないと README の品質バー
 * 「detail layer visible at 0.5 m」が成立しない。
 */
export class WorldBuilder {
  constructor(scene, materials) {
    this.scene = scene;
    this.materials = materials;
    /** paletteKey -> Mesh[] (統合待ち) */
    this._batches = new Map();
    /** 統合しない個別メッシュ。 */
    this.solo = [];
    /** paletteKey -> タイル実寸 (m) のキャッシュ。 */
    this._tileCache = new Map();
  }

  /**
   * パレットキーからマテリアルを解決する。
   *
   * PALETTE のエントリは Three 版から引き継いだもので `opts.tint` と `opts.scale` を
   * 持つ。tint は variant() に渡す。scale は使わない — テクセル密度は pushBox が
   * 実寸から決めるため、per-material のスケールを重ねると二重に効いてしまう。
   *
   * `vertexMasks` と `weather` は Three 版のシェーダ拡張向けパラメータで、新しい
   * 鍛冶場では **焼き込み時に決まる**ため per-instance には適用できない。色分けの
   * 意図は tint で維持される。
   */
  material(key) {
    const p = PALETTE[key];
    if (!p) throw new Error(`[world] unknown palette key "${key}"`);
    const tint = p.opts?.tint;
    return tint === undefined ? this.materials.get(p.name) : this.materials.variant(p.name, { tint });
  }

  /** パレットキーに対応する physics の surface タグ。 */
  surfaceOf(key) {
    return PALETTE[key]?.surface ?? 'concrete';
  }

  /** マテリアルのタイルが覆う実寸 (m)。UV の焼き直しに使う。 */
  _tileMetres(key) {
    let t = this._tileCache.get(key);
    if (t !== undefined) return t;
    const p = PALETTE[key];
    // uvScaleFor(name, 1, 1) は 1/world を返すので、その逆数がタイルの実寸。
    const s = this.materials.uvScaleFor(p.name, 1, 1);
    t = 1 / (s.x || 1);
    this._tileCache.set(key, t);
    return t;
  }

  /**
   * 直方体を積む。中心座標と各辺の長さ (m)。
   *
   * `opts.solo` を立てると統合対象から外れ、個別に動かせるメッシュになる。
   */
  pushBox(x, y, z, w, h, d, key, opts = {}) {
    const mesh = MeshBuilder.CreateBox(
      opts.name ?? `box_${key}`,
      { width: w, height: h, depth: d },
      this.scene
    );
    mesh.position.set(x, y, z);
    if (opts.ry) mesh.rotation.y = opts.ry;
    this._rescaleBoxUv(mesh, w, h, d, this._tileMetres(key));
    return this._file(mesh, key, opts);
  }

  /** 円柱。柱・ドラム缶・パイプに使う。 */
  pushCylinder(x, y, z, diameter, height, key, opts = {}) {
    const mesh = MeshBuilder.CreateCylinder(
      opts.name ?? `cyl_${key}`,
      { diameter, height, tessellation: opts.sides ?? 16 },
      this.scene
    );
    mesh.position.set(x, y, z);
    if (opts.ry) mesh.rotation.y = opts.ry;
    this._rescaleGenericUv(mesh, Math.PI * diameter, height, this._tileMetres(key));
    return this._file(mesh, key, opts);
  }

  /** 水平面 (床・地面)。法線は +Y。 */
  pushGround(x, y, z, w, d, key, opts = {}) {
    const mesh = MeshBuilder.CreateGround(
      opts.name ?? `ground_${key}`,
      { width: w, height: d, subdivisions: opts.subdivisions ?? 1 },
      this.scene
    );
    mesh.position.set(x, y, z);
    this._rescaleGenericUv(mesh, w, d, this._tileMetres(key));
    return this._file(mesh, key, opts);
  }

  _file(mesh, key, opts) {
    mesh.metadata = {
      owPalette: key,
      owSurface: this.surfaceOf(key),
      owNoShadow: opts.noShadow === true,
      owNoCollision: opts.noCollision === true,
    };
    if (opts.solo) {
      mesh.material = this.material(key);
      this.solo.push(mesh);
    } else {
      let list = this._batches.get(key);
      if (!list) this._batches.set(key, (list = []));
      list.push(mesh);
    }
    return mesh;
  }

  /**
   * 箱の UV を実寸ベースに焼き直す。
   *
   * Babylon の箱は 6 面ぶんの UV を 0..1 で持つ。面ごとに「その面の実寸 ÷ タイル
   * 実寸」を掛けると、どの面も 1m あたり同じテクセル数になる。
   *
   * 面の並びは CreateBox の頂点順 (front, back, right, left, top, bottom)。各面
   * 4 頂点なので、面 i の UV は [i*8, i*8+8) に入っている。
   */
  _rescaleBoxUv(mesh, w, h, d, tile) {
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
    if (!uvs) return;
    // 面ごとの (幅, 高さ)。CreateBox の面順に対応。
    const faces = [
      [w, h], // front  (-Z)
      [w, h], // back   (+Z)
      [d, h], // right  (+X)
      [d, h], // left   (-X)
      [w, d], // top    (+Y)
      [w, d], // bottom (-Y)
    ];
    for (let f = 0; f < 6; f++) {
      const su = faces[f][0] / tile;
      const sv = faces[f][1] / tile;
      for (let v = 0; v < 4; v++) {
        const i = f * 8 + v * 2;
        uvs[i] *= su;
        uvs[i + 1] *= sv;
      }
    }
    mesh.setVerticesData(VertexBuffer.UVKind, uvs);
  }

  /** 箱以外 (円柱・地面) の UV を一律スケールする。 */
  _rescaleGenericUv(mesh, spanU, spanV, tile) {
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
    if (!uvs) return;
    const su = spanU / tile;
    const sv = spanV / tile;
    for (let i = 0; i < uvs.length; i += 2) {
      uvs[i] *= su;
      uvs[i + 1] *= sv;
    }
    mesh.setVerticesData(VertexBuffer.UVKind, uvs);
  }

  /**
   * パレットキーごとにメッシュを統合して確定する。
   *
   * 戻り値は統合済みメッシュの配列。呼び出し側がこれを physics と影に登録する。
   *
   * `MergeMeshes(list, disposeSource, allow32BitsIndices, meshSubclass,
   *  subdivideWithSubMeshes, multiMultiMaterials)` — 第 5 引数を false にするのは、
   * サブメッシュに分割すると draw call が戻ってしまい統合の意味が薄れるため。
   */
  finish() {
    const out = [];
    for (const [key, list] of this._batches) {
      if (!list.length) continue;
      const merged =
        list.length === 1 ? list[0] : Mesh.MergeMeshes(list, true, true, undefined, false, false);
      if (!merged) continue;
      merged.name = `world_${key}`;
      merged.material = this.material(key);
      merged.metadata = { owPalette: key, owSurface: this.surfaceOf(key) };
      merged.receiveShadows = true;
      merged.isPickable = true;
      out.push(merged);
    }
    this._batches.clear();
    return out.concat(this.solo);
  }
}
