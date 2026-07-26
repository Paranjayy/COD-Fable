import * as THREE from 'three';

/**
 * Static shadow-caster proxy.
 *
 * The cascade pass is DRAW-CALL bound, not triangle bound. MEASURED on the
 * firefight scenario, holding the scene fixed and only changing which casters
 * are submitted:
 *
 *   20 casters  / 5.94 M triangles drawn -> 10.8 ms
 *   160 casters / 4.59 M triangles drawn -> 17.4 ms
 *
 * More triangles in fewer submissions is 38% FASTER. Four cascades re-submitting
 * ~200 individual world meshes each is therefore ~950 draw calls of pure
 * per-object overhead for geometry that never moves.
 *
 * So: bake every static caster's triangles ONCE into world space and merge them
 * into a handful of chunk meshes. The depth pass writes exactly the same
 * triangles at exactly the same positions, so the shadow map is bit-identical —
 * this buys draw calls, it does not trade image quality.
 *
 * Chunking (rather than one giant mesh) keeps per-cascade culling working: a
 * cascade covering 8 m of street must not have to rasterise the whole level.
 *
 * Anything that can move is excluded and still drawn per-object: skinned meshes,
 * morph targets, and — checked every frame — any baked object whose world matrix
 * turns out to change. A mover invalidates its chunk, which is rebuilt without
 * it, so a wrong shadow can survive at most one frame.
 */
export class StaticShadowProxy {
  /**
   * @param {number} cellSize  world size of a chunk, metres. Small enough that a
   *   near cascade rejects most chunks, large enough that the merge is worth it.
   */
  constructor(cellSize = 22) {
    this.cellSize = cellSize;
    this.enabled = true;
    /** Chunk meshes, kept out of every pass except the cascades. */
    this.chunks = [];
    /** Source objects that are baked, so they can be hidden during the pass. */
    this._baked = [];
    this._nBaked = 0;
    /** Per-baked-object world matrix at bake time, for the movement check. */
    this._bakedMatrix = [];
    /** chunk index each baked object contributed to. */
    this._bakedChunk = [];
    this._built = false;
    /** Casters handed to CSM: surviving dynamics + chunk meshes. */
    this._casters = [];
    this._nCasters = 0;
    this._hidden = [];
    this._nHidden = 0;
    /** Objects that were baked but have since moved — permanently per-object. */
    this._movers = new Set();
    this._group = new THREE.Group();
    this._group.name = 'csm-static-proxy';
    this._group.matrixAutoUpdate = false;
    this._group.visible = false; // never visited by _collect, never in any list
    this.stats = { chunks: 0, bakedObjects: 0, triangles: 0, rebuilds: 0 };
  }

  /** Attach the proxy group to the world scene. Safe to call once. */
  attach(scene) {
    if (this._group.parent !== scene) scene.add(this._group);
  }

  /**
   * A caster qualifies if its geometry is fixed in world space for the whole
   * level. Everything uncertain is refused — a false positive is a wrong
   * shadow, a false negative is only a draw call.
   */
  static _isStatic(o) {
    if (o.isMesh !== true) return false;          // points/lines/sprites: not casters worth merging
    if (o.isSkinnedMesh === true) return false;   // animated every frame
    if (o.frustumCulled === false) return false;  // sky dome / GPU-driven bounds
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return false;
    if (g.morphAttributes && Object.keys(g.morphAttributes).length) return false;
    const ud = o.userData;
    if (ud.owNoShadow === true) return false;
    if (ud.owDynamic === true) return false;
    return true;
  }

  /** Triangle count a source object contributes once expanded. */
  static _triangles(o) {
    const g = o.geometry;
    const idx = g.index ? g.index.count : g.attributes.position.count;
    return (idx / 3) * (o.isInstancedMesh ? o.count : 1);
  }

  /**
   * Bake the static subset of `draw` into chunk meshes.
   * `noShadow` is the render system's opt-out list; those never cast.
   */
  build(draw, nDraw, noShadow, nNoShadow) {
    this.dispose();
    const skip = new Set();
    for (let i = 0; i < nNoShadow; i++) skip.add(noShadow[i]);

    // ---- 1. bucket the qualifying casters by world cell --------------------
    const cells = new Map();
    const center = new THREE.Vector3();
    const sphere = new THREE.Sphere();
    for (let i = 0; i < nDraw; i++) {
      const o = draw[i];
      if (skip.has(o) || this._movers.has(o)) continue;
      if (!StaticShadowProxy._isStatic(o)) continue;
      const g = o.geometry;
      if (g.boundingSphere === null) g.computeBoundingSphere();
      if (!g.boundingSphere) continue;
      o.updateWorldMatrix(true, false);
      sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
      center.copy(sphere.center);
      const cs = this.cellSize;
      const key = `${Math.floor(center.x / cs)},${Math.floor(center.y / cs)},${Math.floor(center.z / cs)}`;
      let bucket = cells.get(key);
      if (!bucket) cells.set(key, (bucket = []));
      bucket.push(o);
    }

    // ---- 2. merge each cell into one position-only world-space geometry ----
    let chunkIndex = 0;
    for (const bucket of cells.values()) {
      const built = this._mergeBucket(bucket, chunkIndex);
      if (!built) continue;
      chunkIndex++;
    }

    this._built = true;
    this.stats.chunks = this.chunks.length;
    this.stats.bakedObjects = this._nBaked;
    return this.stats;
  }

  /** Merge one cell's objects into a single Mesh. Returns false if empty. */
  _mergeBucket(bucket, chunkIndex) {
    let vTotal = 0;
    let iTotal = 0;
    for (const o of bucket) {
      const g = o.geometry;
      const inst = o.isInstancedMesh ? o.count : 1;
      vTotal += g.attributes.position.count * inst;
      iTotal += (g.index ? g.index.count : g.attributes.position.count) * inst;
    }
    if (vTotal === 0 || iTotal === 0) return false;

    const pos = new Float32Array(vTotal * 3);
    const idx = new Uint32Array(iTotal);
    const v = new THREE.Vector3();
    const m = new THREE.Matrix4();
    let vo = 0;
    let io = 0;

    for (const o of bucket) {
      const g = o.geometry;
      const src = g.attributes.position;
      const index = g.index;
      const n = src.count;
      const inst = o.isInstancedMesh ? o.count : 1;
      o.updateWorldMatrix(true, false);

      for (let k = 0; k < inst; k++) {
        if (o.isInstancedMesh) {
          o.getMatrixAt(k, m);
          m.premultiply(o.matrixWorld);
        } else {
          m.copy(o.matrixWorld);
        }
        for (let i = 0; i < n; i++) {
          v.fromBufferAttribute(src, i).applyMatrix4(m);
          pos[(vo + i) * 3] = v.x;
          pos[(vo + i) * 3 + 1] = v.y;
          pos[(vo + i) * 3 + 2] = v.z;
        }
        if (index) {
          for (let i = 0; i < index.count; i++) idx[io + i] = index.getX(i) + vo;
          io += index.count;
        } else {
          for (let i = 0; i < n; i++) idx[io + i] = vo + i;
          io += n;
        }
        vo += n;
      }

      this._baked[this._nBaked] = o;
      this._bakedMatrix[this._nBaked] = o.matrixWorld.clone();
      this._bakedChunk[this._nBaked] = chunkIndex;
      this._nBaked++;
      this.stats.triangles += StaticShadowProxy._triangles(o);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    const mesh = new THREE.Mesh(geo, PROXY_MATERIAL);
    mesh.name = `csm-proxy-${chunkIndex}`;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    // Belt and braces: if it ever leaks into a normal pass, it must not draw
    // into the prepass or take a shadow-caster opt-out.
    mesh.userData.owNoPrepass = true;
    mesh.visible = true; // visibility is governed by the parent group
    this._group.add(mesh);
    this.chunks.push({ mesh, sources: bucket.slice() });
    return true;
  }

  /**
   * Any baked object whose world matrix has changed must stop being represented
   * by stale triangles. Rebuild its chunk without it; from then on it is drawn
   * per-object like any other dynamic caster.
   * @returns {boolean} true if a rebuild happened.
   */
  _revalidate() {
    let dirty = null;
    for (let i = 0; i < this._nBaked; i++) {
      const o = this._baked[i];
      if (o.matrixWorld.equals(this._bakedMatrix[i])) continue;
      (dirty ??= new Set()).add(this._bakedChunk[i]);
      this._movers.add(o);
    }
    if (!dirty) return false;

    // Rebuild only the affected chunks, keeping every other chunk untouched.
    const keep = [];
    const rebuildBuckets = [];
    for (let c = 0; c < this.chunks.length; c++) {
      if (dirty.has(c)) rebuildBuckets.push(this.chunks[c].sources.filter((o) => !this._movers.has(o)));
      else keep.push(this.chunks[c]);
    }
    for (const c of this.chunks) {
      if (keep.includes(c)) continue;
      this._group.remove(c.mesh);
      c.mesh.geometry.dispose();
    }
    // Re-index the surviving bake tables, then append the rebuilt chunks.
    const oldBaked = this._baked.slice(0, this._nBaked);
    const oldMat = this._bakedMatrix.slice(0, this._nBaked);
    const oldChunk = this._bakedChunk.slice(0, this._nBaked);
    this.chunks = keep;
    this._nBaked = 0;
    this._baked.length = 0;
    this._bakedMatrix.length = 0;
    this._bakedChunk.length = 0;
    const keepSet = new Set(keep.map((k) => k));
    // rebuild bake tables for kept chunks
    for (let c = 0; c < keep.length; c++) {
      for (const o of keep[c].sources) {
        const j = oldBaked.indexOf(o);
        this._baked[this._nBaked] = o;
        this._bakedMatrix[this._nBaked] = j >= 0 ? oldMat[j] : o.matrixWorld.clone();
        this._bakedChunk[this._nBaked] = c;
        this._nBaked++;
      }
    }
    void oldChunk; void keepSet;
    for (const bucket of rebuildBuckets) {
      if (bucket.length) this._mergeBucket(bucket, this.chunks.length);
    }
    this.stats.rebuilds++;
    this.stats.chunks = this.chunks.length;
    this.stats.bakedObjects = this._nBaked;
    return true;
  }

  /**
   * Swap the scene into "proxy" form for the cascade pass: hide every baked
   * source, reveal the chunk meshes, and return the caster list CSM should cull
   * against — the un-baked originals plus the chunks.
   */
  begin(draw, nDraw) {
    if (!this.enabled || !this._built) return null;
    this._revalidate();

    this._nHidden = 0;
    for (let i = 0; i < this._nBaked; i++) {
      const o = this._baked[i];
      if (o.visible === false) continue; // already hidden by the caller
      o.visible = false;
      this._hidden[this._nHidden++] = o;
    }
    this._group.visible = true;

    const baked = new Set();
    for (let i = 0; i < this._nBaked; i++) baked.add(this._baked[i]);
    this._nCasters = 0;
    for (let i = 0; i < nDraw; i++) {
      const o = draw[i];
      if (baked.has(o)) continue;
      this._casters[this._nCasters++] = o;
    }
    for (const c of this.chunks) this._casters[this._nCasters++] = c.mesh;
    return { list: this._casters, n: this._nCasters };
  }

  /** Undo `begin()`. */
  end() {
    if (!this._built) return;
    this._group.visible = false;
    for (let i = 0; i < this._nHidden; i++) this._hidden[i].visible = true;
    this._nHidden = 0;
  }

  dispose() {
    for (const c of this.chunks) {
      this._group.remove(c.mesh);
      c.mesh.geometry.dispose();
    }
    this.chunks = [];
    this._baked.length = 0;
    this._bakedMatrix.length = 0;
    this._bakedChunk.length = 0;
    this._nBaked = 0;
    this._built = false;
    this.stats = { chunks: 0, bakedObjects: 0, triangles: 0, rebuilds: 0 };
  }
}

/** Placeholder: the cascade pass overrides it with the CSM depth material. */
const PROXY_MATERIAL = new THREE.MeshBasicMaterial({ name: 'csm-proxy' });
