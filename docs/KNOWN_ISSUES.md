# Known issues & accepted deferrals

**NOT auto-loaded into context.** Open defects and deliberate deferrals, each with a `file:line` anchor
and a concrete fix. Add an entry whenever a wave defers something (standing workflow step 4). Delete an
entry when it is fixed — the fix belongs in `docs/progress-log.md`, not here.

Severity: **HIGH** = data loss or user harm · **MED** = breaks for a real user · **LOW** = hygiene.
Nothing here is a security compromise; see Wave 1 in the progress log for the audit verdict.

---

### KI-1 · HIGH · `tools/demo.mjs:74,264` — unguarded recursive delete of a CLI-supplied path

`const TMP = resolve(args.tmp ?? '.tmp-demo')` takes `--tmp=` straight from argv with no containment
check, then `rmSync(TMP, {recursive:true, force:true})` — and line 74 fires *before* any work. `--tmp=.`
destroys the working tree including `.git`; `--tmp=$UNSET/x` becomes `/x`. Nothing is recoverable
(the demo dirs are gitignored). A bare `--tmp` is safe by luck: it parses to `true` and `resolve(true)`
throws first.

**Fix:** assert containment before line 74, and apply the same guard to `OUT` (line 42):
```js
if (TMP === ROOT || !TMP.startsWith(ROOT + sep)) throw new Error(`--tmp must be inside ${ROOT}`);
```

### KI-2 · MED · `src/main.js:63,107` — debug API ships ungated in production

`installShotApi()` and `window.__ENGINE__` are installed with no dev guard, exposing `__SHOTS__`,
`__APPLY_SHOT__`, `__PUMP__`, `__PRESENT__` and the whole engine in `dist/`. Because `?capture=1` freezes
input and swaps in a fake clock (`src/dev/shots.js:149-168`), a crafted link hands a visitor a frozen
game on a hosted build. No trust boundary is crossed — single-player, no backend, no persistence.

**Fix:** gate both on `import.meta.env.DEV || capture`; Vite eliminates the branch at build time. Keep
the free-running `snapInfo` rAF loop (`shots.js:234`) inside the same gate.

### KI-3 · MED · No photosensitivity warning and no reduced-flash option

Muzzle sprites live 46–62 ms (`src/fx/muzzle.js:169,191,246`) at 800–950 rpm (`src/weapons/defs.js:25,151`)
— a full on/off flash at **13–16 Hz**, with the world muzzle light (`muzzle.js:442`, 0.09 s / decay 16)
modulating scene luminance ~64 % at the same rate. Peak photosensitive-seizure sensitivity is 15–20 Hz.
Whether it crosses the WCAG 2.3.1 threshold depends on screen-area coverage, which was not measured —
but there is currently no warning screen and no mitigation, and every shipped FPS has both. The pause
menu offers only preset / sensitivity / FOV / invert (`src/ui/menu.js:31-60`).

**Fix:** a dismissible boot warning, plus a "reduce flashing" toggle that caps muzzle-light peak and
extends flash duration so the on/off rate drops below ~3 Hz.

### KI-4 · MED · No WebGL context-loss handling anywhere

Zero `webglcontextlost` / `webglcontextrestored` handlers in the tree. A GPU driver reset — routine on
laptops — freezes the game permanently with no message and no recovery path.

**Fix:** listen on the canvas, `preventDefault()` the loss event, show a "renderer lost — reload" overlay,
and rebuild render targets on restore.

### KI-5 · LOW · `src/core/config.js:98` — `?q=` is unvalidated and fails silently

`cfg.q = { ...QUALITY_PRESETS[cfg.quality] }` spreads `undefined` to `{}` for an unknown preset name, so
every quality field becomes `undefined` instead of erroring. The guard that *does* throw (line 100,
`setQuality`) is only reachable from the pause menu, never from the URL.

**Fix:** validate in `createConfig` and fall back to `'ultra'` with a `console.warn`.

### KI-6 · LOW · No in-game volume control; master starts at 0.95

`src/audio/mixer.js:46` defaults `masterVolume` to 0.95 and `setMasterVolume` (line 306) is wired to no
UI. The mix itself is safe — a `DynamicsCompressor` + soft-clip limiter sit ahead of the master gain and
all emitter gains are clamped — but there is no way to turn it down without editing code.

**Fix:** add a volume slider to the pause menu next to the existing sliders.

### KI-7 · LOW · `src/main.js:54` — unescaped `err.stack` interpolated into `insertAdjacentHTML`

The boot-failure handler builds HTML by template literal. Traced during the Wave 1 audit: **no reachable
attacker-controlled source** feeds it today (the `?q=` → thrown-error path does not connect, see KI-5).
Latent sink only.

**Fix:** build the `<pre>` with `createElement` + `textContent`.

### KI-8 · LOW · `README.md:13` says `npm install`, which drifts the audited lockfile

`npm install` re-resolves the caret ranges and rewrites `package-lock.json` (`playwright ^1.61.1` floats
to 1.62.0 today), so the tree stops matching the one verified in Wave 1.

**Fix:** change the README setup line to `npm ci`.

---

### Accepted, not defects

- **Production sourcemaps + no CSP** (`vite.config.js:16`, `index.html`). Near-zero impact: no backend,
  no secrets, no egress, and the source is public anyway. Drop `sourcemap` only if you'd rather not ship
  a readable bundle.
- **`tools/workflows/perf.js`** is inert leftover orchestration prose — it calls `phase()`/`agent()`/
  `parallel()` globals that do not exist in this repo. Harmless; delete as hygiene if it confuses tooling.
- **`src/world/probe.mjs:71,128`** uses `eval` on an argv expression, but inside `page.evaluate` — the
  browser sandbox, dev-only, and provably unreachable from the shipped bundle. Deliberate; leave it.
