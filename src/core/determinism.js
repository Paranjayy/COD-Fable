import { Rng } from './rng.js';

/**
 * サードパーティ (Babylon) 内部の乱数を決定化する。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ## なぜ必要か — 実測で特定した非決定性
 *
 * ARCHITECTURE.md の Hard rule 4 は「**自分たちのコード**で Math.random() を使うな」
 * だが、**ライブラリの中まではその規約が届かない**。
 *
 * 実際に Babylon 9 の `thinSSAO2PostProcess.js:205` は AO のサンプルカーネルを
 * `Math.random()` で生成している:
 *
 *     vector = this._hemisphereSampleUniform(Math.random(), Math.random());
 *
 * ページを読み込むたびに別のカーネルになるので、**同じ入力から違う絵が出る**。
 * Babylon 全体では 16 ファイルが Math.random() を使っており、SSAO 以外にも
 * 潜在的な発生源がある。
 *
 * ### 発見までの経緯 (二分探索の実測値。480x270, hero, settle=30, 2 回実行の差分)
 *
 * | 設定                  | maxDelta | changed% |
 * |-----------------------|----------|----------|
 * | 全部有効              |    21    |   29.5   |
 * | mblur=0               |    16    |   31.5   |
 * | taa=0 & mblur=0       |   190    |   82.6   |  ← TAA を切ると悪化
 * | gtao=0 & mblur=0      |     1    |    0.1   |  ← SSAO を切ると解消
 *
 * **TAA を切ると悪化する**のが決定的な手がかりだった。TAA は SSAO のノイズを
 * フレーム間で平均して隠していただけで、原因ではなかった。「TAA が怪しい」と
 * 決めつけて調べていたら辿り着けなかった。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ## 方針
 *
 * キャプチャモードでは `Math.random` 自体を **シード付きの実装に差し替える**。
 * 個別のライブラリにパッチを当てるより:
 *
 *   - Babylon のバージョンが上がって新しい Math.random() が増えても勝手に守られる
 *   - 「どのライブラリが乱数を使っているか」を追跡する必要がない
 *
 * **通常プレイでは差し替えない。** 毎回同じ AO カーネルになること自体に害はないが、
 * グローバルを書き換える副作用はキャプチャという明確な目的があるときだけに限定する。
 *
 * ## 自分たちのコードの規約は緩めない
 *
 * これは「Math.random() を使ってよくなった」という意味では **ない**。差し替えは
 * キャプチャ時のみで、通常プレイでは素の Math.random に戻る。ゲームプレイのロジックが
 * これに依存すると「キャプチャでは動くが実プレイでは揺れる」という最悪の形になる。
 * ゲームプレイの乱数は必ず `ctx.rng` を使うこと。
 */

let _original = null;
let _calls = 0;

/**
 * `Math.random` をシード付きに差し替える。
 *
 * **Babylon のオブジェクトを 1 つでも作る前に呼ぶこと。** SSAO のカーネルは
 * パイプラインのコンストラクタで生成されるので、後から差し替えても手遅れになる。
 *
 * @param seed 32bit のシード。ctx.rng と同じ値にしておくと追跡しやすい
 */
export function installDeterministicRandom(seed = 0x5eed1234) {
  if (_original) return; // 二重適用を防ぐ
  _original = Math.random;
  const rng = new Rng(seed);
  _calls = 0;
  Math.random = () => {
    _calls++;
    return rng.float();
  };
}

/** 元の Math.random に戻す。HMR とテストのため。 */
export function restoreRandom() {
  if (!_original) return;
  Math.random = _original;
  _original = null;
}

/**
 * 差し替え後に何回呼ばれたか。
 *
 * 診断用。**この数がキャプチャの実行ごとに変わるなら、まだどこかに実時計や
 * 環境依存の分岐が残っている** (呼ばれる回数が経路に依存しているということ)。
 * bit-identical が崩れたときに最初に見る値。
 */
export function randomCallCount() {
  return _calls;
}

export function isDeterministicRandomInstalled() {
  return _original !== null;
}
