#!/usr/bin/env node
/**
 * Per-pixel comparison of two shot directories.
 *
 * This is the gate that enforces "no visual change" during optimisation work:
 * an optimisation is only allowed to land if every shot is pixel-identical (or
 * within an explicitly justified epsilon) to the pre-optimisation baseline.
 *
 *   node tools/imagediff.mjs --a=shots/base --b=shots/opt [--tol=1] [--write-diff]
 *
 * tol is the per-channel 0-255 delta below which a pixel counts as unchanged.
 *
 * Exit code: 0 within epsilon, 1 when a shot changed or is missing on either
 * side, 2 when there was nothing to compare at all.
 */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const A = resolve(args.a), B = resolve(args.b);
const TOL = Number(args.tol ?? 0);

// `--write-diff` drops `<shot>.diff.png` into B, so those are excluded from
// both listings, otherwise a second run would compare a diff against nothing.
const shots = (dir) =>
  (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith('.png') && !f.endsWith('.diff.png'))
    .sort();

const names = shots(A);
const onlyInB = shots(B).filter((n) => !names.includes(n));
const rows = [];
let worst = null;

// An empty comparison set is a broken run, not a pass: `every` on it is true,
// so a baseline directory that exists but holds no shots (tools/baseline.mjs
// creates the directory before capturing, and every shot can still fail) used
// to certify any change as pixel-identical.
if (names.length === 0 && onlyInB.length === 0) {
  const why = !existsSync(A) ? `directory does not exist: ${A}`
    : !existsSync(B) ? `directory does not exist: ${B}`
    : `no .png shots found in ${A} or ${B}`;
  console.log(JSON.stringify(
    { a: A, b: B, tol: TOL, identical: false, withinEpsilon: false,
      error: `nothing to compare: ${why}`, worst: null, rows: [] },
    null, 2
  ));
  console.error(`imagediff: nothing to compare: ${why}`);
  process.exit(2);
}

for (const n of onlyInB) rows.push({ shot: n, status: 'MISSING_IN_A' });

for (const n of names) {
  const pb = join(B, n);
  if (!existsSync(pb)) { rows.push({ shot: n, status: 'MISSING_IN_B' }); continue; }
  const a = PNG.sync.read(readFileSync(join(A, n)));
  const b = PNG.sync.read(readFileSync(pb));
  if (a.width !== b.width || a.height !== b.height) {
    rows.push({ shot: n, status: 'SIZE_MISMATCH', a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` });
    continue;
  }
  let diffPx = 0, sum = 0, maxD = 0;
  const total = a.width * a.height;
  const diff = args['write-diff'] ? new PNG({ width: a.width, height: a.height }) : null;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i+1] - b.data[i+1]);
    const db = Math.abs(a.data[i+2] - b.data[i+2]);
    const d = Math.max(dr, dg, db);
    sum += d;
    if (d > maxD) maxD = d;
    const changed = d > TOL;
    if (changed) diffPx++;
    if (diff) {
      // Changed pixels in hot magenta over a dimmed original for eyeballing.
      diff.data[i]   = changed ? 255 : a.data[i] >> 2;
      diff.data[i+1] = changed ? 0   : a.data[i+1] >> 2;
      diff.data[i+2] = changed ? 255 : a.data[i+2] >> 2;
      diff.data[i+3] = 255;
    }
  }
  if (diff) writeFileSync(join(B, n.replace('.png', '.diff.png')), PNG.sync.write(diff));
  const pct = (diffPx / total) * 100;
  const row = { shot: n, changedPct: +pct.toFixed(4), maxDelta: maxD, meanDelta: +(sum / total).toFixed(3) };
  rows.push(row);
  if (!worst || pct > worst.changedPct) worst = row;
}

const identical = rows.every((r) => r.changedPct === 0);
const clean = rows.every((r) => (r.changedPct ?? 100) < 0.05 && (r.maxDelta ?? 255) <= Math.max(2, TOL));
console.log(JSON.stringify({ a: A, b: B, tol: TOL, identical, withinEpsilon: clean, worst, rows }, null, 2));
process.exit(clean ? 0 : 1);
