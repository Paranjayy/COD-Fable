import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * ===========================================================================
 * CameraView — HUD が使うカメラ情報の SSOT
 * ===========================================================================
 *
 * HUD は毎フレーム「ワールド座標 → 画面ピクセル」と「カメラの水平方位」を必要と
 * する。Three 版ではこれが markers.js (射影) と index.js (方位) に分散していて、
 * どちらも `camera.matrixWorld.elements` を直接読んでいた。Babylon では行列の
 * 取り方も NDC の規約も違うため、**変換を 1 箇所に閉じ込める**。ここを直せば
 * markers / minimap / compass がまとめて追随する。
 *
 * ---------------------------------------------------------------------------
 * Babylon 移植で踏んだ罠 (後続の作業者向け)
 * ---------------------------------------------------------------------------
 *
 * 1. **`scene.getTransformMatrix()` を使ってはいけない。**
 *    engine のフレーム順は `update → lateUpdate → render` (src/core/engine.js
 *    step 参照)。scene の transform matrix が更新されるのは render の中なので、
 *    lateUpdate で読むと **1 フレーム前の行列**が返る。HUD だけが 1 フレーム遅れて
 *    追従する、という極めて発見しにくいズレになる。ここでは camera から view と
 *    projection を直接取って自前で掛ける。どちらも Babylon 側でキャッシュされて
 *    いるので追加コストは行列積 1 回だけ。
 *
 * 2. **射影後の z で「背後か」を判定してはいけない。**
 *    Three は NDC z > 1 が背後だったが、Babylon の NDC z の範囲は backend 依存で
 *    WebGPU は 0..1、WebGL2 は -1..1 (`engine.isNDCHalfZRange`)。backend を
 *    切り替えた瞬間にオフスクリーン矢印の向きが壊れる。視線ベクトルとの内積で
 *    判定すれば規約に依存しない。
 *
 * 3. **`Vector3.copyFrom()` はプレーンな `{x,y,z}` を受け付けない。**
 *    Babylon の実装は `source._x` を読むため、イベントペイロードのような素の
 *    オブジェクトを渡すと **例外も出さずに undefined → NaN** になる。外部由来の
 *    座標は必ず `copyFromFloats(p.x, p.y, p.z)` 経由で取り込むこと。ここでは
 *    `project()` が数値 3 つを受ける形にして、そもそも Vector3 を要求しない。
 */

/**
 * カメラのローカル軸。
 *
 * scene.useRightHandedSystem = true (src/core/engine.js) なので前方は -Z。
 * ここを +Z にすると HUD のマーカーが全部背面判定になり、画面端に貼り付く。
 */
const FORWARD_LOCAL = new Vector3(0, 0, -1);
const RIGHT_LOCAL = new Vector3(1, 0, 0);

const RAD2DEG = 180 / Math.PI;

export class CameraView {
  constructor() {
    /** view * projection。project() が使う。 */
    this._vp = new Matrix();
    /** カメラのワールド位置。 */
    this.eye = new Vector3();
    /** カメラ前方 (正規化済み、3D)。背面判定に使う。 */
    this.forward = new Vector3();
    /** カメラ右方向 (正規化済み、3D)。 */
    this.right = new Vector3();

    /** 水平面に落として正規化した基底。ダメージ方向アークとコンパスが使う。 */
    this.fx = 0;
    this.fz = -1;
    this.rx = 1;
    this.rz = 0;
    /** 北 (-Z) を 0 とした方位角 [deg]。コンパスとミニマップが使う。 */
    this.heading = 0;
    /**
     * 垂直 FOV [deg]。
     *
     * **Babylon の `camera.fov` はラジアン**。Three 版は度だったので、そのまま
     * ミニマップの視野コーンに渡すと 80° のはずのコーンが 1.4° になって消える。
     */
    this.fovDeg = 80;

    /** HUD の論理解像度 (CSS ピクセル)。 */
    this.w = 1;
    this.h = 1;

    /** project() の返り値。呼び出し側は次の project() まで保持してはいけない。 */
    this.proj = { x: 0, y: 0, dist: 0, behind: false, offscreen: false, angle: 0 };

    this._ndc = new Vector3();
    this._p = new Vector3();
  }

  /**
   * フレーム頭で 1 回だけ呼ぶ。
   * @param {import('@babylonjs/core/Cameras/camera.js').Camera} camera
   * @param {number} w HUD 幅 (CSS px)
   * @param {number} h HUD 高さ (CSS px)
   */
  update(camera, w, h) {
    this.w = w;
    this.h = h;

    // getViewMatrix / getProjectionMatrix は内部キャッシュ付き。player が
    // update() で動かした結果はここで確実に反映される。
    camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), this._vp);

    const m = camera.getWorldMatrix().m;
    this.eye.copyFromFloats(m[12], m[13], m[14]);
    camera.getDirectionToRef(FORWARD_LOCAL, this.forward);
    camera.getDirectionToRef(RIGHT_LOCAL, this.right);

    // 水平基底。真上/真下を向くと長さ 0 になるので保険を入れる。
    const fl = Math.hypot(this.forward.x, this.forward.z) || 1;
    this.fx = this.forward.x / fl;
    this.fz = this.forward.z / fl;
    const rl = Math.hypot(this.right.x, this.right.z) || 1;
    this.rx = this.right.x / rl;
    this.rz = this.right.z / rl;

    this.heading = Math.atan2(this.fx, -this.fz) * RAD2DEG;
    this.fovDeg = camera.fov * RAD2DEG;
  }

  /**
   * ワールド座標を HUD ピクセルへ射影する。
   *
   * 画面外のターゲットは安全域の内側の矩形リングにクランプし、`angle` に
   * 「そちらを指す矢印の回転角」を返す (CoD の画面外オブジェクティブと同じ挙動)。
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} margin リングと画面端の距離 [px]
   * @returns {{x:number,y:number,dist:number,behind:boolean,offscreen:boolean,angle:number}}
   *          共有スクラッチ。次の呼び出しで上書きされる。
   */
  project(x, y, z, margin) {
    const w = this.w;
    const h = this.h;

    const ex = x - this.eye.x;
    const ey = y - this.eye.y;
    const ez = z - this.eye.z;
    const dist = Math.hypot(ex, ey, ez);
    // 罠 2 参照: NDC z ではなく視線との内積で判定する。
    const behind = ex * this.forward.x + ey * this.forward.y + ez * this.forward.z <= 0;

    this._p.copyFromFloats(x, y, z);
    // TransformCoordinatesToRef は w で割る (符号も保つ) ので、背後の点は
    // Three の .project() と同じく中心対称に反転した位置に出る。下の
    // `x = w - x` はその反転を打ち消して矢印を正しい向きに戻すためのもの。
    Vector3.TransformCoordinatesToRef(this._p, this._vp, this._ndc);

    let sx = (this._ndc.x * 0.5 + 0.5) * w;
    let sy = (-this._ndc.y * 0.5 + 0.5) * h;
    if (behind) {
      sx = w - sx;
      sy = h - sy;
    }

    const cx = w * 0.5;
    const cy = h * 0.5;
    let dx = sx - cx;
    let dy = sy - cy;
    const mx = w * 0.5 - margin;
    const my = h * 0.5 - margin;
    let off = behind;
    if (Math.abs(dx) > mx || Math.abs(dy) > my) {
      off = true;
      const s = Math.min(mx / (Math.abs(dx) || 1e-4), my / (Math.abs(dy) || 1e-4));
      dx *= s;
      dy *= s;
    }

    const p = this.proj;
    p.x = cx + dx;
    p.y = cy + dy;
    p.dist = dist;
    p.behind = behind;
    p.offscreen = off;
    p.angle = Math.atan2(dy, dx) * RAD2DEG + 90;
    return p;
  }

  /** `{x,y,z}` でも Babylon の Vector3 でも受ける版。 */
  projectPoint(pos, margin) {
    return this.project(pos.x, pos.y, pos.z, margin);
  }
}
