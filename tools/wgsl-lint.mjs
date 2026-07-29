#!/usr/bin/env node
/**
 * WGSL 予約語リンタ。
 *
 * ## なぜ必要か — 実際に起きた事故
 *
 * `let macro = fbm2p(...)` と書いたところ、`macro` は WGSL の予約語だったため
 * シェーダモジュールの生成が失敗した。厄介なのはここからで:
 *
 *   1. Babylon の `ProceduralTexture.isReady()` は **true を返した**。
 *      (Babylon から見れば effect は作られており、失敗したのは WebGPU の
 *       パイプライン生成という一段下のレイヤ)
 *   2. `render()` も例外を投げず、テクスチャは **真っ黒のまま**焼き上がった。
 *   3. エラーは GPUValidationError としてブラウザ console にしか出ない。
 *
 * つまり **「例外が出ない・isReady が true・でも絵は真っ黒」** という、最も
 * 発見の遅れる形で失敗する。tools/matbake.mjs の統計ゲート (分散がゼロなら
 * 失敗と判定する) が実際にこれを捕まえたが、原因の特定にはブラウザ console を
 * 読む必要があった。
 *
 * このリンタはその一段手前で、ブラウザを起動せずに同じ事故を止める。
 *
 *   node tools/wgsl-lint.mjs
 *
 * exit 0 = 予約語の使用なし。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * WGSL 予約語 (https://www.w3.org/TR/WGSL/#reserved-words)。
 *
 * 「将来のために予約」されているだけで現時点で意味を持たない語も含まれる。
 * 意味が無いからこそ「なぜ使えないのか」がエラーメッセージから分かりにくい。
 */
const RESERVED = new Set(
  `NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await
   become binding_array cast catch class co_await co_return co_yield coherent column_major
   common compile compile_fragment concept const_cast consteval constexpr constinit crate
   debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export
   extends extern external fixed fragment friend from get goto groupshared highp impl
   implements import inline instanceof interface layout lowp macro macro_rules match mediump
   meta mod module move mutable namespace new nil noexcept noinline nointerpolation
   non_coherent noncoherent noperspective null nullptr of operator package packoffset
   partition pass patch pixelfragment precise precision premerge priv protected pub public
   readonly ref regardless register reinterpret_cast require resource restrict self set
   shared sizeof smooth snorm static static_assert static_cast std subroutine super target
   tempate template this thread_local throw trait try type typedef typeid typename union
   unless unorm unsafe unsized use using varying virtual volatile wchar_t where with
   writeonly yield`
    .split(/\s+/)
    .filter(Boolean)
);

const ROOT = resolve(import.meta.dirname, '..');
const WGSL_DIRS = [join(ROOT, 'src/materials/wgsl'), join(ROOT, 'src/sky/wgsl'), join(ROOT, 'src/fx/wgsl')];

/** `let x` / `var x` / `fn x(` の宣言名を拾う。 */
const DECL = /\b(?:let|var|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
/** 構造体メンバや関数引数 `name: type` も拾う。 */
const TYPED = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:vec[234][fiu]?|f32|i32|u32|bool|mat[234]x[234]f|sampler|texture_2d)/g;

const findings = [];

/**
 * WGSL 文字列 (テンプレートリテラル) の中にバッククォートが書かれていないか調べる。
 *
 * ## なぜ必要か — これも実際に起きた事故 (2 回)
 *
 * WGSL は JS のテンプレートリテラルに埋め込んでいる。その中の JSDoc に
 * 「識別子をバッククォートで囲む」という普通の書き方をすると、**リテラルがそこで
 * 終端して JS の構文エラーになる**。しかもエラーメッセージは
 * 「Unexpected identifier 'eye'」のように、原因と全く無関係に見える文言になる。
 *
 * 予約語チェックと違い、これはブラウザを起動する前に JS のパース時点で落ちるので
 * 発見はできる。ただしメッセージから原因に辿り着くのに時間がかかるため、ここで
 * 「バッククォートが原因である」と名指しできるようにしておく。
 */
function findBacktickInWgsl(src, path) {
  const out = [];
  const lines = src.split('\n');
  let inside = false;
  lines.forEach((line, i) => {
    if (!inside && /\/\* wgsl \*\/ `/.test(line)) {
      inside = true;
      return;
    }
    if (inside && /^\s*`;?\s*$|^\s*`,\s*$/.test(line)) {
      inside = false;
      return;
    }
    if (inside && line.includes('`')) {
      out.push({ file: path, line: i + 1, identifier: '`', text: line.trim(), kind: 'backtick' });
    }
  });
  return out;
}

for (const dir of WGSL_DIRS) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  } catch {
    continue; // まだ存在しないディレクトリは黙って飛ばす
  }
  for (const f of files) {
    const path = join(dir, f);
    const src = readFileSync(path, 'utf8');
    const lines = src.split('\n');
    findings.push(...findBacktickInWgsl(src, path.replace(ROOT + '/', '')));
    for (const re of [DECL, TYPED]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        if (!RESERVED.has(m[1])) continue;
        const line = src.slice(0, m.index).split('\n').length;
        findings.push({
          file: path.replace(ROOT + '/', ''),
          line,
          identifier: m[1],
          text: (lines[line - 1] ?? '').trim(),
        });
      }
    }
  }
}

// 同じ箇所を 2 つの正規表現が拾うことがあるので重複を潰す。
const seen = new Set();
const unique = findings.filter((f) => {
  const k = `${f.file}:${f.line}:${f.identifier}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (unique.length) {
  console.error('WGSL lint findings:\n');
  for (const f of unique) {
    if (f.kind === 'backtick') {
      console.error(`  ${f.file}:${f.line}  WGSL リテラル内にバッククォートがあります`);
      console.error(`    ${f.text}`);
      console.error(
        '    → テンプレートリテラルがここで終端し、無関係に見える JS 構文エラーになります。'
      );
    } else {
      console.error(`  ${f.file}:${f.line}  "${f.identifier}" is reserved`);
      console.error(`    ${f.text}`);
      console.error(
        '    → シェーダが黙って失敗します (例外なし / isReady()=true / 絵は真っ黒)。改名してください。'
      );
    }
  }
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, scanned: WGSL_DIRS.length, findings: 0 }, null, 2));
