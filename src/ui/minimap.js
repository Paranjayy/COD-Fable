import { el, clamp, clamp01, lerp } from './util.js';
import { STREET, ALLEYS, BUILDINGS, GATE } from '../world/layout.js';

const BAKE = 512; // マップビットマップの解像度 (px)

/**
 * ===========================================================================
 * 戦術ミニマップ (左上)
 * ===========================================================================
 *
 * マップは `src/world/layout.js` のレイアウトデータから一度だけ描き起こす。
 * 街路と路地を「明るい負の空間」として塗り、その上に建物のフットプリントを
 * 置く — 自分が立っている路地が形で分かることがミニマップの唯一の仕事なので、
 * 道が読めることを最優先にしている。焼き上げ後の毎フレームのコストは drawImage
 * 1 回とブリップだけ。
 *
 * プレイヤー矢印は中心に固定されて回転する (マップは北固定で、コンパスの帯と
 * 一致する)。敵ブリップは ai サブシステムが `getHudActors()` で公開したもの。
 *
 * ---------------------------------------------------------------------------
 * Babylon 移植: 深度ベイクを捨てた理由 (元に戻さないこと)
 * ---------------------------------------------------------------------------
 *
 * Three 版はここで「シーンを MeshDepthMaterial + 正射影カメラで 512² の
 * WebGLRenderTarget に描き、readRenderTargetPixels で読み戻して高さフィールドを
 * 作る」という経路を持っていた。これは Babylon では **2 つの理由で成立しない**:
 *
 *   1. `render.renderer` はもう Three の WebGLRenderer ではなく Babylon の Engine
 *      で、`setRenderTarget` / `readRenderTargetPixels` / `scene.overrideMaterial`
 *      に相当する API が無い。Babylon で書き直すなら RenderTargetTexture +
 *      カスタムマテリアル + **非同期の** readPixels() になり、決定性ベイクとして
 *      扱いにくい (キャプチャのフレーム境界を跨ぐ)。
 *   2. そもそも Three 版のコメント自身が「深度ベイクは屋根のプロップ・パラペット・
 *      庇・ケーブル・瓦礫まで拾ってしまい、街路のない丸い塊の集合になる」と認めて
 *      いて、ベクタマップ側が本命だった。
 *
 * 旧ベクタマップは `world.levelToWorld()` / `world.isOpen()` / `world.buildings`
 * という実行時 API を経由していたが、**Babylon 版の WorldSystem はこれらを公開して
 * いない**。一方でレイアウトデータ (layout.js) は Three 版からそのまま再利用されて
 * おり、WorldSystem 自身もここからジオメトリを組んでいる。したがって layout.js を
 * 直接読むのが SSOT として正しい: マップと実際の建物が定義上ズレようがない。
 *
 * **レベル空間 = ワールド空間**である点に依存している。Three 版はレベル全体を
 * yaw 回転させていたので affine 復元が要ったが、Babylon 版の WorldSystem は
 * layout.js の座標をそのままワールドに置いている (src/world/index.js の
 * _buildGround 等を参照)。もし将来レベルを回転させるなら、ここに同じ回転を
 * 掛ける必要がある — 忘れるとマップだけが回らずに街路が建物とズレる。
 */
export class Minimap {
  constructor(parent, rng) {
    this.root = el('div', 'ow-minimap', parent);
    this.canvas = el('canvas', null, this.root);
    this.g = this.canvas.getContext('2d');
    for (const c of ['tl', 'tr', 'bl', 'br']) el('div', 'ow-mm-corner ' + c, this.root);
    el('div', 'ow-mm-n', this.root, 'N');
    const tag = el('div', 'ow-mm-tag', this.root);
    el('span', null, tag, 'ZONE 07');
    this.scaleTag = el('span', null, tag, '60M');

    this.rng = rng;
    this.k = 1;
    this.cssSize = 178;
    this.span = 190; // ベイクが覆うワールドの一辺 [m]
    this.viewSpan = 60; // ウィジェットに映る一辺 [m]
    /** ベイクの中心 (ワールドの x/z)。レベルは原点まわりに組まれている。 */
    this.centre = { x: 0, z: 0 };

    this.baked = null;
    this.bakeDone = false;

    this.resize(1);
  }

  resize(k) {
    this.k = k;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(this.cssSize * k * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    this.px = px;
  }

  /* --------------------------------------------------------------- bake --- */

  /**
   * レイアウトデータからマップビットマップを一度だけ描き起こす。
   *
   * 冪等かつ同期。GPU にもシーングラフにも触らないので、ワールドの構築状況を
   * 待つ必要が無く「数フレーム後にリトライ」という仕掛けは不要になった。
   */
  tryBake() {
    if (this.bakeDone) return;
    this.bakeDone = true; // 失敗しても再試行しない (レイアウトは静的データなので直らない)
    try {
      this.baked = this._buildLayoutMap();
    } catch (err) {
      // マップが無くてもグリッドとブリップだけで最低限は成立する。HUD 全体を
      // 巻き添えにしない。
      console.warn('[ui] minimap bake failed', err);
      this.baked = null;
    }
  }

  /**
   * 街路 → 建物 → グレインの順に塗る。
   *
   * 街路を「明るい負の空間」にしているのが肝。建物を明るく塗ると屋根の集合に
   * 見えてしまい、自分が居る路地が読めない。CoD のミニマップが道を明るく抜いて
   * いるのと同じ理由。
   */
  _buildLayoutMap() {
    const N = BAKE;
    const ppm = N / this.span; // ビットマップ px / metre
    const cv = document.createElement('canvas');
    cv.width = N;
    cv.height = N;
    const g = cv.getContext('2d');

    // 場外の地面。パネル上で最も暗いトーンだが、黒には決してしない。
    g.fillStyle = '#2b343d';
    g.fillRect(0, 0, N, N);

    // ワールド (metre) → ビットマップ (px)。以降はすべてメートルで書ける。
    g.setTransform(ppm, 0, 0, ppm, N * 0.5 - this.centre.x * ppm, N * 0.5 - this.centre.z * ppm);

    // ---- 通行可能な負の空間: 本通り + 路地 --------------------------------
    // STREET.kerb が建物線なので、車道 + 両側の歩道がこの幅にあたる。
    g.fillStyle = '#63717e';
    g.fillRect(-STREET.kerb, STREET.zMin, STREET.kerb * 2, STREET.zMax - STREET.zMin);
    for (const a of ALLEYS) {
      const [x0, z0, x1, z1] = a.rect;
      // rect は [x0,z0,x1,z1] で、z0 > z1 の並びもある (layout.js の東側の中庭)。
      // 正規化しないと幅が負になって塗られない。
      g.fillStyle = a.surface === 'gravel' ? '#5c6874' : '#63717e';
      g.fillRect(Math.min(x0, x1), Math.min(z0, z1), Math.abs(x1 - x0), Math.abs(z1 - z0));
    }

    // ---- 建物のフットプリント ---------------------------------------------
    for (const spec of BUILDINGS) this._footprint(g, spec.x, spec.z, spec.w, spec.d, spec.floors ?? 2);

    // ---- 門 (遠景を締めるアーチ) ------------------------------------------
    // 街路を跨ぐ塊なので、描かないとマップ上で本通りが場外まで抜けて見える。
    this._footprint(g, (GATE.xL0 + GATE.xL1) / 2, GATE.z, GATE.xL1 - GATE.xL0, GATE.depth, 3);
    this._footprint(g, (GATE.xR0 + GATE.xT1) / 2, GATE.z, GATE.xT1 - GATE.xR0, GATE.depth, 4);

    g.setTransform(1, 0, 0, 1, 0, 0);

    // ---- グレイン: HUD の面はどこもベタ塗りにしない -----------------------
    // Math.random() ではなく ui が握る Rng fork を使う (ARCHITECTURE Hard rule 4)。
    // ベイクは 1 回きりなので、このフォークの消費量はフレーム数に依存しない。
    const img = g.getImageData(0, 0, N, N);
    const d = img.data;
    const rng = this.rng;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng.float() - 0.5) * 5.5;
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n;
      d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  /**
   * 建物 1 棟のフットプリント。座標は中心 + 寸法 (layout.js の規約)。
   *
   * 北 (-Z) と西 (-X) の辺に明るい返しを、南東側に影を入れる。壁を共有する 2 棟が
   * 1 つの塊に潰れて見えるのを防ぐための、疑似キーライト。
   */
  _footprint(g, cx, cz, w, d, floors) {
    const x0 = cx - w * 0.5;
    const z0 = cz - d * 0.5;
    // 高い塊ほどわずかに明るく。マップ上でスカイラインが読める。
    const t = clamp01((floors - 1) / 3);
    g.fillStyle =
      'rgb(' + Math.round(lerp(50, 68, t)) + ',' +
      Math.round(lerp(59, 79, t)) + ',' +
      Math.round(lerp(68, 90, t)) + ')';
    g.fillRect(x0, z0, w, d);
    g.fillStyle = 'rgba(206,228,244,.20)';
    g.fillRect(x0, z0, w, 0.34);
    g.fillRect(x0, z0, 0.34, d);
    g.fillStyle = 'rgba(3,7,10,.34)';
    g.fillRect(x0, z0 + d - 0.34, w, 0.34);
    g.fillRect(x0 + w - 0.34, z0, 0.34, d);
  }

  /* --------------------------------------------------------------- draw --- */

  /**
   * @param {object} s { x, z, heading(deg), fov(deg), blips:[{x,z,kind,heading}],
   *                     objectives:[{x,z,label}] }
   */
  draw(s) {
    const g = this.g;
    const S = this.px;
    if (!S) return;
    const half = S * 0.5;
    const ppm = S / this.viewSpan; // canvas pixels per metre

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);

    // base plate — never pure black, always slightly blue. Opaque, and every
    // layer above it is opaque or drawn over it, so the widget composites as a
    // single solid tile: nothing in the scene can show through the map.
    g.fillStyle = '#2b343d';
    g.fillRect(0, 0, S, S);

    g.save();
    g.beginPath();
    g.rect(0, 0, S, S);
    g.clip();

    const cx = s.x ?? 0;
    const cz = s.z ?? 0;

    if (this.baked) {
      const bppm = BAKE / this.span;
      const srcW = this.viewSpan * bppm;
      const sx = (cx - this.centre.x) * bppm + BAKE * 0.5 - srcW * 0.5;
      const sy = (cz - this.centre.z) * bppm + BAKE * 0.5 - srcW * 0.5;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(this.baked, sx, sy, srcW, srcW, 0, 0, S, S);
    } else {
      g.fillStyle = '#2b333b';
      g.fillRect(0, 0, S, S);
    }

    // 10m grid, phase-locked to world space so it scrolls with the player
    const u = S / this.cssSize; // canvas pixels per css reference pixel
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(10,17,23,.20)';
    g.beginPath();
    const n0x = Math.floor((cx - this.viewSpan * 0.5) / 10);
    const n1x = Math.ceil((cx + this.viewSpan * 0.5) / 10);
    for (let n = n0x; n <= n1x; n++) {
      const X = Math.round((n * 10 - cx) * ppm + half) + 0.5;
      g.moveTo(X, 0);
      g.lineTo(X, S);
    }
    const n0z = Math.floor((cz - this.viewSpan * 0.5) / 10);
    const n1z = Math.ceil((cz + this.viewSpan * 0.5) / 10);
    for (let n = n0z; n <= n1z; n++) {
      const Y = Math.round((n * 10 - cz) * ppm + half) + 0.5;
      g.moveTo(0, Y);
      g.lineTo(S, Y);
    }
    g.stroke();

    // view cone
    const heading = ((s.heading ?? 0) * Math.PI) / 180;
    const fov = (((s.fov ?? 80) * 0.5) * Math.PI) / 180;
    const coneR = S * 0.42;
    const grad = g.createRadialGradient(half, half, 2, half, half, coneR);
    grad.addColorStop(0, 'rgba(222,242,255,.26)');
    grad.addColorStop(0.7, 'rgba(222,242,255,.075)');
    grad.addColorStop(1, 'rgba(214,238,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(half, half);
    g.arc(half, half, coneR, -Math.PI / 2 + heading - fov, -Math.PI / 2 + heading + fov);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(226,244,255,.17)';
    g.lineWidth = 1;
    g.stroke();

    // objectives
    const objs = s.objectives;
    if (objs) {
      g.font = `700 ${(9.5 * u).toFixed(1)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const r = 6 * u;
      for (let i = 0; i < objs.length; i++) {
        const o = objs[i];
        const dx = clamp((o.x - cx) * ppm + half, r + 1, S - r - 1);
        const dy = clamp((o.z - cz) * ppm + half, r + 1, S - r - 1);
        g.fillStyle = 'rgba(121,210,255,.94)';
        g.strokeStyle = 'rgba(4,14,20,.8)';
        g.lineWidth = 1;
        g.beginPath();
        g.rect(dx - r, dy - r, r * 2, r * 2);
        g.fill();
        g.stroke();
        g.fillStyle = '#06171f';
        g.fillText(o.label ?? '', dx, dy + 0.5);
      }
    }

    // blips
    const blips = s.blips;
    if (blips) {
      for (let i = 0; i < blips.length; i++) {
        const b = blips[i];
        const dx = (b.x - cx) * ppm + half;
        const dy = (b.z - cz) * ppm + half;
        if (dx < -8 || dy < -8 || dx > S + 8 || dy > S + 8) continue;
        const enemy = b.kind !== 'friend';
        const r = 3.4 * u;
        g.save();
        g.translate(dx, dy);
        g.rotate(((b.heading ?? 0) * Math.PI) / 180);
        g.fillStyle = enemy ? 'rgba(255,74,58,.96)' : 'rgba(126,196,255,.95)';
        g.shadowColor = enemy ? 'rgba(255,60,40,.85)' : 'rgba(120,190,255,.7)';
        g.shadowBlur = 6 * u;
        g.beginPath();
        g.moveTo(0, -r * 1.5);
        g.lineTo(r * 1.15, r * 1.1);
        g.lineTo(-r * 1.15, r * 1.1);
        g.closePath();
        g.fill();
        g.restore();
      }
    }

    // player arrow
    g.save();
    g.translate(half, half);
    g.rotate(heading);
    const pr = 4.8 * u;
    g.beginPath();
    g.moveTo(0, -pr * 1.55);
    g.lineTo(pr * 1.15, pr * 1.3);
    g.lineTo(0, pr * 0.6);
    g.lineTo(-pr * 1.15, pr * 1.3);
    g.closePath();
    g.fillStyle = '#f6fcff';
    g.strokeStyle = 'rgba(2,6,10,.85)';
    g.lineWidth = 1.6 * u;
    g.lineJoin = 'round';
    g.shadowColor = 'rgba(180,225,255,.85)';
    g.shadowBlur = 5 * u;
    g.stroke();
    g.fill();
    g.shadowBlur = 0;
    g.restore();

    // edge falloff so the map sinks into the frame instead of ending abruptly
    const vg = g.createRadialGradient(half, half, S * 0.28, half, half, S * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.17)');
    g.fillStyle = vg;
    g.fillRect(0, 0, S, S);

    g.restore();
  }

  dispose() {
    this.baked = null;
    this.root.remove();
  }
}
