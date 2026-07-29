import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * 太陽と月が実際にどこにあるか。
 *
 * 標準的な球面天文学: 通日から赤緯、地方太陽時から時角、緯度で高度/方位に変換する。
 * 手置きの値は無いので、重要なショットは 3 つの別々のアートパスではなく
 * **1 つの整合した空**から出てくる。
 *
 * ## なぜ簡易軌道 (sin カーブ) ではダメなのか
 *
 * dev/shots.js のショットリストは Three 版のこのモデルを前提に時刻が振られている。
 * サイトと日付は「グレーディング済みの時刻がショットリストの言う場所に来る」よう
 * 選ばれている (緯度 45N、夏至、日没 19.71 時):
 *
 *   16.50  太陽 +32.0°, 方位 272 (真西)   — 硬い午後のキーライト
 *   19.20  太陽  +4.6°, 方位 299 (西北西) — ゴールデンアワー、太陽円板がフレーム内
 *   01.50  太陽 -18.6°                    — 完全な夜
 *          月   +21.7°, 方位 288 (西)     — 半月、フレーム内
 *
 * 最初の Babylon 移植は「日の出 6 時 / 日没 18 時」の sin カーブで代用しており、
 * 19.2 時の sunset ショットが太陽高度 -18.6° (= 真っ暗な夜) になって空が黒一色に
 * なった。**時刻→太陽位置の対応はショットリストとの契約**なので、この天文計算を
 * 簡略化してはいけない。
 *
 * 方位の規約: 0 = 北 = -Z、90 = 東 = +X。`northAngleDeg` は天文計算に触れずに
 * 天球全体を回すアートディレクション用のつまみ。
 *
 * (Three 版にあった星空用の celestialMatrix は、星のレンダリングを移植したときに
 * 一緒に持ってくること。ここでは未使用なので省いている。)
 */

export const SITE = {
  latitudeDeg: 45.0,
  dayOfYear: 172, // 夏至
  /** ワールド空間の北を回す。0 で北 = -Z のまま。 */
  northAngleDeg: 0,
  /**
   * 月の時角オフセット (太陽からの度数) と月の赤緯。
   *
   * 244 / +28 (月の赤緯の実限界) は 01:30 に月を高度 22 / 方位 288 に置く。これは
   * night ショットの視錐台の**内側**。Three 版で 216.8 / +12 にしていた頃は方位 250
   * となり左端から 20 度外れ、「月明かりの街を見せるためのフレームに月が無い」
   * 状態だった。この赤緯では輝面比も 58% になり、明暗境界が読めて円板が平坦な
   * 白い点ではなく球に見える。
   */
  moonHourOffsetDeg: 244.0,
  moonDeclinationDeg: 28.0,
};

const DEG = Math.PI / 180;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 太陽赤緯。Cooper の近似式。 */
export function solarDeclination(dayOfYear) {
  return 23.44 * DEG * Math.sin(((2 * Math.PI) / 365) * (284 + dayOfYear));
}

/**
 * 与えた時角と赤緯の天体の高度/方位。
 * `hourAngle` はラジアン。子午線通過で 0、午後に正。
 */
export function altAz(hourAngle, declination, latitudeDeg, out = { alt: 0, az: 0 }) {
  const lat = latitudeDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinD = Math.sin(declination);
  const cosD = Math.cos(declination);
  const sinAlt = sinLat * sinD + cosLat * cosD * Math.cos(hourAngle);
  const alt = Math.asin(clamp(sinAlt, -1, 1));
  const cosAlt = Math.cos(alt);
  let cosAz = 0;
  if (cosAlt > 1e-6 && cosLat > 1e-6) {
    cosAz = (sinD - sinAlt * sinLat) / (cosAlt * cosLat);
  }
  let az = Math.acos(clamp(cosAz, -1, 1));
  // 時角が正 = 子午線を過ぎた = 空の西半分。
  if (Math.sin(hourAngle) > 0) az = 2 * Math.PI - az;
  out.alt = alt;
  out.az = az;
  return out;
}

/** 高度/方位からワールド空間の単位ベクトル。**天体の方を指す。** */
export function dirFromAltAz(alt, az, northAngleRad, out) {
  const a = az + northAngleRad;
  const ca = Math.cos(alt);
  out.set(ca * Math.sin(a), Math.sin(alt), -ca * Math.cos(a));
  return out.normalize();
}

/**
 * ある時刻の天体状態一式。`sun` / `moon` は天体を指す単位ワールド方向。
 *
 * ベクトルは再利用する (毎フレーム呼ばれても GC を出さない — Hard rule 5)。
 */
export class Celestial {
  constructor(site = SITE) {
    this.site = { ...site };
    this.sun = new Vector3(0, 1, 0);
    this.moon = new Vector3(0, -1, 0);
    this.sunAlt = 0;
    this.sunAz = 0;
    this.moonAlt = 0;
    this.moonAz = 0;
    this._aa = { alt: 0, az: 0 };
  }

  setHour(hour) {
    const s = this.site;
    const north = s.northAngleDeg * DEG;
    const decl = solarDeclination(s.dayOfYear);
    // 時角: 12 時に 0、1 時間 = 15 度。
    const H = (hour - 12) * 15 * DEG;

    altAz(H, decl, s.latitudeDeg, this._aa);
    this.sunAlt = this._aa.alt;
    this.sunAz = this._aa.az;
    dirFromAltAz(this.sunAlt, this.sunAz, north, this.sun);

    const Hm = H + s.moonHourOffsetDeg * DEG;
    altAz(Hm, s.moonDeclinationDeg * DEG, s.latitudeDeg, this._aa);
    this.moonAlt = this._aa.alt;
    this.moonAz = this._aa.az;
    dirFromAltAz(this.moonAlt, this.moonAz, north, this.moon);

    return this;
  }
}
