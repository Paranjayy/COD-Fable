import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { el, svg, setText, setStyle, setClass, Pool, ease, clamp01, metres } from './util.js';

/**
 * ワールド座標に紐づく HUD 要素: 距離付きオブジェクティブマーカー、手榴弾の危険
 * 表示、飛び上がるダメージ数値。
 *
 * 画面外のターゲットは安全域の内側の矩形リングにクランプされ、グリフがそちらを
 * 指すシェブロンに差し替わる — 背を向けた CoD のオブジェクティブと同じ挙動。
 *
 * ---------------------------------------------------------------------------
 * Babylon 移植メモ
 * ---------------------------------------------------------------------------
 * 射影は自前で持たず `CameraView` (src/ui/camera-view.js) に委譲する。理由は
 * そちらのコメント参照 (要点: lateUpdate では scene.getTransformMatrix() が
 * 1 フレーム古い / NDC z の範囲が backend 依存)。このモジュールが受け取る `view`
 * は毎フレーム index.js が更新済みのものなので、ここでは読むだけでよい。
 */

function diamond(parent) {
  const s = svg('svg', { viewBox: '0 0 16 16' }, parent);
  svg(
    'rect',
    {
      x: 3.2,
      y: 3.2,
      width: 9.6,
      height: 9.6,
      transform: 'rotate(45 8 8)',
      fill: 'rgba(121,210,255,.9)',
      stroke: 'rgba(6,20,28,.75)',
      'stroke-width': 1,
    },
    s
  );
  return s;
}

function chevron(parent) {
  const s = svg('svg', { viewBox: '0 0 16 16' }, parent);
  svg('path', { d: 'M8 1.5 14.4 13H1.6z', fill: 'rgba(121,210,255,.95)', stroke: 'rgba(6,20,28,.7)', 'stroke-width': 1 }, s);
  return s;
}

function nadeGlyph(parent) {
  const s = svg('svg', { viewBox: '0 0 16 16' }, parent);
  svg('circle', { cx: 8, cy: 8, r: 5.4, fill: 'rgba(255,63,49,.95)', stroke: 'rgba(0,0,0,.5)', 'stroke-width': 1 }, s);
  svg('rect', { x: 7.2, y: 0.8, width: 1.6, height: 3.2, fill: 'rgba(255,63,49,.95)' }, s);
  return s;
}

export class WorldMarkers {
  constructor(parent, rng) {
    this.rng = rng;
    this.objRoot = el('div', 'ow-layer', parent);
    this.objPool = new Pool(
      6,
      () => {
        const node = el('div', 'ow-mk');
        const gl = el('div', 'ow-mk-glyph', node);
        const dia = diamond(gl);
        const chev = chevron(gl);
        chev.style.display = 'none';
        const letter = el('div', 'ow-mk-letter', gl, 'A');
        const dist = el('div', 'ow-mk-dist', node, '0M');
        const name = el('div', 'ow-mk-name', node, '');
        node._dia = dia;
        node._chev = chev;
        node._letter = letter;
        node._dist = dist;
        node._name = name;
        return node;
      },
      this.objRoot
    );

    this.nadePool = new Pool(
      4,
      () => {
        const node = el('div', 'ow-nade');
        const ring = el('div', 'ow-nade-ring', node);
        const core = el('div', 'ow-nade-core', node);
        nadeGlyph(core);
        const label = el('div', 'ow-nade-label', node, 'GRENADE');
        node._ring = ring;
        node._label = label;
        node._pos = new Vector3();
        return node;
      },
      this.objRoot
    );

    this.dnPool = new Pool(
      16,
      () => {
        const node = el('div', 'ow-dn');
        node._pos = new Vector3();
        return node;
      },
      this.objRoot
    );
  }

  /**
   * @param {Array} list [{ position:{x,y,z}, label:'A', name:'CAPTURE', color }]
   * @param {import('./camera-view.js').CameraView} view
   * @param {number} k HUD スケール
   */
  updateObjectives(list, view, k) {
    const items = this.objPool.items;
    let n = 0;
    const margin = 74 * k;
    if (list) {
      for (let i = 0; i < list.length && n < items.length; i++) {
        const o = list[i];
        if (!o?.position) continue;
        const p = view.projectPoint(o.position, margin);
        const it = items[n++];
        if (!it.alive) {
          it.alive = true;
          setStyle(it.node, 'display', '');
        }
        const node = it.node;
        setStyle(node, 'transform', `translate(${(p.x - 20 * k).toFixed(1)}px,${(p.y - 12 * k).toFixed(1)}px)`);
        setStyle(node, 'width', `${(40 * k).toFixed(1)}px`);
        setText(node._letter, o.label ?? '');
        setText(node._dist, metres(p.dist));
        setText(node._name, o.name ?? '');
        const edge = p.offscreen;
        setStyle(node._dia, 'display', edge ? 'none' : '');
        setStyle(node._chev, 'display', edge ? '' : 'none');
        setStyle(node._letter, 'opacity', edge ? '0' : '1');
        if (edge) setStyle(node._chev, 'transform', `rotate(${p.angle.toFixed(1)}deg)`);
        // distant markers dim so a busy map doesn't turn into a wall of icons
        const fade = clamp01(1.15 - p.dist / 260) * (edge ? 0.72 : 1);
        setStyle(node, 'opacity', fade.toFixed(3));
      }
    }
    for (let i = n; i < items.length; i++) {
      if (items[i].alive) {
        items[i].alive = false;
        setStyle(items[i].node, 'display', 'none');
      }
    }
  }

  /**
   * @param {{x:number,y:number,z:number}} position
   * @param {number} fuse 起爆までの秒数
   */
  spawnGrenade(position, fuse = 2.4) {
    const it = this.nadePool.acquire();
    it.life = fuse;
    // copy() ではなく copyFromFloats(): Babylon の Vector3.copyFrom は source._x を
    // 読むため、イベント由来のプレーンな {x,y,z} を渡すと黙って NaN になる。
    it.node._pos.copyFromFloats(position.x, position.y, position.z);
    return it;
  }

  updateGrenades(dt, view, k) {
    const items = this.nadePool.items;
    const margin = 56 * k;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.alive) continue;
      it.t += dt;
      if (it.t >= it.life) {
        this.nadePool.release(it);
        continue;
      }
      const node = it.node;
      const p = view.projectPoint(node._pos, margin);
      setStyle(node, 'transform', `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`);
      const close = p.dist < 9;
      setText(node._label, close ? 'DANGER CLOSE' : 'GRENADE');
      // pulse rate ramps as the fuse burns down
      const remain = 1 - it.t / it.life;
      const rate = 2.2 + (1 - remain) * 5;
      const ph = (it.t * rate) % 1;
      const rs = 0.7 + 0.9 * ease.outCubic(ph);
      setStyle(node._ring, 'transform', `scale(${rs.toFixed(3)})`);
      setStyle(node._ring, 'opacity', (0.9 * (1 - ph)).toFixed(3));
      setStyle(node, 'opacity', clamp01(remain * 4).toFixed(3));
    }
  }

  /** @param {'hit'|'hs'|'kill'|'armour'} kind */
  spawnDamage(position, amount, kind = 'hit') {
    const it = this.dnPool.acquire();
    it.life = kind === 'kill' ? 1.25 : 0.95;
    // spawnGrenade と同じ理由で copyFromFloats を使う。
    it.node._pos.copyFromFloats(position.x, position.y, position.z);
    it.a = this.rng.signed() * 16; // lateral drift
    it.b = 0.9 + this.rng.float() * 0.25;
    setText(it.node, Math.round(amount));
    setClass(it.node, 'hs', kind === 'hs');
    setClass(it.node, 'kill', kind === 'kill');
    setClass(it.node, 'armour', kind === 'armour');
    return it;
  }

  updateDamage(dt, view, k) {
    const items = this.dnPool.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.alive) continue;
      it.t += dt;
      const u = it.t / it.life;
      if (u >= 1) {
        this.dnPool.release(it);
        continue;
      }
      const node = it.node;
      const p = view.projectPoint(node._pos, 0);
      if (p.behind) {
        setStyle(node, 'opacity', '0');
        continue;
      }
      const rise = ease.outCubic(clamp01(u * 1.15)) * 42 * k * it.b;
      const drift = it.a * k * ease.outQuad(u);
      const pop = 1 + 0.35 * (1 - ease.outQuint(clamp01(u / 0.12)));
      setStyle(
        node,
        'transform',
        `translate(${(p.x + drift).toFixed(1)}px,${(p.y - rise).toFixed(1)}px) translate(-50%,-50%) scale(${pop.toFixed(3)})`
      );
      const a = u < 0.55 ? 1 : 1 - ease.inQuad((u - 0.55) / 0.45);
      setStyle(node, 'opacity', (a * clamp01(2.6 - p.dist / 90)).toFixed(3));
    }
  }

  clear() {
    this.nadePool.releaseAll();
    this.dnPool.releaseAll();
  }

  dispose() {
    this.objRoot.remove();
  }
}
