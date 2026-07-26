# Claude of Duty (Nikeverse-fps) — CLAUDE.md

Notes for AI assistants working in this repo. **Auto-loaded every session — keep it lean.**
**DURABLE FACTS ONLY.** No commit SHAs, no dates, no "✅ done" narration, no findings lists —
per-wave history goes in `docs/progress-log.md` (append-only, grep it by wave number), open defects
go in `docs/KNOWN_ISSUES.md`. The engine contract lives in `ARCHITECTURE.md` — **do not duplicate it
here**; point at it. Edit this file only when a *rule* changes.

## ⭐ THE STANDING WORKFLOW — every part, every time (owner-mandated; READ FIRST)

**Per part, in this exact order — never skip a phase:**

1. **Multi-agent brainstorm / plan → ONE consensus spec.** Spin up a wave of Opus minds (incl. the lead)
   in distinct designer/architect hats, armed with `ARCHITECTURE.md` + the relevant subsystem source
   **+ web research where the answer is external** (a rendering technique, a real-world ballistics or
   physics figure, what a shipped AAA title actually does). They bounce ideas and **converge on one
   EXACT spec BEFORE any code is written.** Trivial/mechanical parts may skip to step 2; anything
   design-, feel-, or architecture-bearing gets the brainstorm.
2. **Multi-agent builder wave.** Parallelize across *independent* chunks — **never two builders on one
   file**, and never a builder outside its subsystem directory (see `ARCHITECTURE.md` rule 1).
3. **Multi-agent reviewer wave.** Distinct lenses (e.g. engine-correctness/determinism · visual-fidelity ·
   perf/allocation · tests-&-latent-bugs), **read-only**, each returning findings ranked
   **BLOCKER / SHOULD-FIX / NIT** with `file:line`, a concrete fix, and a verdict.
4. **Lead QC + fix.** **Verify every finding yourself — never obey an agent blindly** (agents report
   confidently and are sometimes wrong; reproduce before you act). Then fix the full appropriate set:
   blockers, should-fixes, **AND nits wherever the fix is low-risk.** Defer only genuine out-of-scope or
   forward-fit items, and record each deferral in `docs/KNOWN_ISSUES.md`.
5. **Rebase onto latest `main` and land.** Rebase the feature branch, re-run the verify gate below
   (a clean rebase is not a passing build), then land. Never force-push shared history.
6. **Update `CLAUDE.md` (durable facts only) + append a `docs/progress-log.md` entry.**
7. **Next part → repeat from 1.**

Run a wave in parallel: **one message, multiple Agent calls.** Brief every agent with the repo path and
branch, the exact files + line anchors, the relevant `ARCHITECTURE.md` sections, and the deliverable
format. Commit **atomically** — the shared/engine change first, in isolation, then each subsystem.

## 🛑 NEVER — each ships a silent defect or is unrecoverable

1. **Never push to `main` directly; never open a PR unless asked.** Branch = `claude/<name>` from the
   session brief. `git push -u origin <branch>`, retry 4× on network failure (2s/4s/8s/16s).
2. **Never put the model identifier** in commits, code, or docs.
3. **Never add an npm dependency.** `three` is the only runtime dep, and the zero-egress property below
   depends on the tree staying this small. New dep ⇒ ask the owner first.
4. **Never introduce network egress, browser storage, or `eval` into `src/`.** This codebase is verified
   to make **zero** outbound requests and touch **zero** localStorage/cookies/IndexedDB. That is a load-
   bearing property, not an accident — it is why the repo is safe to run and to fork from. Any `fetch`,
   `WebSocket`, `sendBeacon`, analytics, CDN asset, or `eval` in the shipped bundle breaks it.
5. **Never load an external art asset.** No models, HDRIs, images or audio files — every texture, mesh,
   animation and sound is generated procedurally at load. This is the repo's whole thesis.
6. **Never edit outside your subsystem directory**, and never import another subsystem's module —
   reach it at runtime via `ctx.get(id)`. (`ARCHITECTURE.md` rules 1–2.)
7. **Never use `Math.random()` in gameplay or visuals** — use `ctx.rng` / `ctx.rng.fork()`. Capture
   reproducibility depends on it.
8. **Never allocate per-frame.** A `new THREE.Vector3()` inside `update()` is a bug; preallocate in `init()`.
9. **Never run `tools/demo.mjs --tmp=<path>`** without checking the path — see Gotcha 6.

## ✅ Verify — both must be green before you call a change done

`npm run build` (must pass) · `node tools/capture.mjs` (must produce a frame). If you break the boot,
every parallel agent is blocked. Setup: **`npm ci`** — *not* `npm install`, which re-resolves the caret
ranges and rewrites the lockfile. Screenshot tooling additionally needs `npx playwright install chromium`
(see Gotcha 7). There is no test runner and no linter in this repo.

## What this is

A browser first-person shooter — Three.js r180 + WebGL2 + Vite, ~68k lines across 11 subsystems, with
**no art assets** (everything procedural). Written end-to-end by an orchestrated agent fleet; `prompt.md`
is the single prompt that produced it. **This is a fork of a public upstream, kept as a reference for
building our own games.** Upstream history is not tracked here, so don't assume an oddity is ours — and
keep changes reviewable as a diff against the original.

## Layer map

**`ARCHITECTURE.md` is the contract — read it before writing code.** It holds the subsystem interface,
the directory ownership map (11 ids, one dir each), the `ctx.events` vocabulary, the surface-type list,
the render integration surface, and the pre-warm contract.

Owned by the lead, **do not edit as a subsystem agent**: `src/core/`, `src/main.js`, `src/dev/`,
`tools/`, `vite.config.js`.

## Gotchas — the traps that cost real time

1. **WebGL2 is a hard requirement** — `src/render/index.js:149` throws with no fallback. Safari is the
   platform to actually test; Chrome/Edge/Firefox are fine.
2. **Quality defaults to `ultra` with NO hardware detection** (`src/core/config.js:85`). That preset is
   heavy: 4096²×4 CSM at 200 m, TAA + GTAO + SSR + volumetrics + motion blur, full render scale. Use
   `?q=low|medium|high` while iterating. **`?q=` is unvalidated** — an unknown value makes
   `QUALITY_PRESETS[name]` spread to `{}`, silently setting every quality field to `undefined`.
   Presets only scale shadows and post; **geometry load is constant across presets** (~1.1k draw calls,
   ~8.3M tris), so they will not rescue a weak GPU.
3. **`?capture=1` is not a passive flag.** It freezes input and monkey-patches `engine.step` onto a fake
   1/60 clock (`src/dev/shots.js`). Therefore **`window.__RENDER_INFO__.ms` is a synthetic timestep, never
   a performance measurement** — do not quote it as a frame time. Use `tools/perf.mjs` for real pacing.
4. **The debug API ships in production**, ungated: `installShotApi()` and `window.__ENGINE__`
   (`src/main.js:63,107`) expose `__SHOTS__`/`__APPLY_SHOT__`/`__PUMP__`/`__ENGINE__` in `dist/`.
5. **Pre-warm is load-bearing.** `src/core/prewarm.js` compiles ~136 shader permutations before the first
   frame; without it Three compiles lazily *during play* and produces multi-second stalls. It is proven
   pixel-neutral. Opt out with `?prewarm=0` only for A/B work.
6. **`tools/demo.mjs` can delete your work.** `--tmp=` is `resolve()`d with no containment check and fed
   to `rmSync(recursive, force)` at line 74, *before* any work happens. `--tmp=.` destroys the working
   tree including `.git`. Default (`.tmp-demo`) is safe.
7. **`npm ci` does not install browsers.** `playwright` has no install script, so every capture/probe tool
   fails until `npx playwright install chromium`. The tools also need a **real GPU** — under software
   rasterization a single `ultra` frame takes >30 s and blows the default screenshot timeout.
8. **The visible point-light count is a shader permutation key.** One lamp crossing its cull radius
   recompiles every lit material (+33–36 programs, 640–900 ms on that frame). Keep the visible count
   constant — see the ARCHITECTURE.md section of the same name for the two sanctioned techniques.
9. **Servers bind `127.0.0.1` only** (`vite.config.js`), `strictPort`. `OW_NO_HMR=1` disables HMR so a
   concurrent agent's file save cannot reload the page mid-capture.

## Doc map

`ARCHITECTURE.md` — the engine contract (subsystem interface · ownership · events · surfaces · render API)
`README.md` — what each subsystem does, controls, the tooling table · `prompt.md` — the originating prompt
**`docs/progress-log.md`** — append-per-wave history; **NOT auto-loaded**, grep it by wave number for
"why is this like this" · **`docs/KNOWN_ISSUES.md`** — open defects and accepted deferrals, with `file:line`
