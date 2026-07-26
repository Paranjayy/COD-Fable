# Progress log

**NOT auto-loaded into context.** Append one entry per wave; never rewrite history. Grep it by wave
number (`## Wave 7`) or by subsystem tag when you need "why is this like this". This is where SHAs,
dates, agent counts, verdicts and narration belong — keep all of it out of `CLAUDE.md`.

**Entry format** — copy this block, keep it to ~15 lines:

```
## Wave N — <short title>            [subsystem tags: render, fx, …]
Branch: claude/<name> · landed <SHA-short> (or: not landed, see KNOWN_ISSUES)
Goal:      one sentence — what this wave was for.
Plan:      the consensus spec the brainstorm converged on, in 2–3 bullets. Note rejected alternatives.
Built:     what changed, by file. One line each.
Review:    lenses run · findings raised B/S/N · what the lead verified vs. overturned.
Fixed:     what was actually fixed. Deferrals → KNOWN_ISSUES, with the reason.
Verify:    npm run build ✓/✗ · tools/capture.mjs ✓/✗ · anything else run.
Learned:   durable facts discovered. Anything rule-shaped → promote to CLAUDE.md in the same commit.
```

---

## Wave 1 — Security / malware audit of the fork    [tags: repo-wide, tooling, supply-chain]

Branch: `claude/nikeverse-fps-security-review-erjiu5` · audit-only, no source changes.

**Goal:** the fork was taken from a public upstream as a reference for building our own games. Establish
that it is safe to clone, `npm install`, and run on the owner's machine — malware, backdoors, covert
egress, supply-chain tampering.

**Plan:** three independent lenses in parallel, no shared notes, so agreement means something —
(a) malicious-code / exfiltration / obfuscation / secrets / git-history hunt; (b) supply chain, build
config, and the Node tooling that runs with full user privileges; (c) lead took the browser-side attack
surface (DOM sinks, storage, input capture, resource exhaustion) and empirical runtime verification.

**Built:** nothing — read-only audit by design. `package-lock.json` was touched by a local `npm install`
and restored; `dist/` and `node_modules/` are gitignored build products.

**Review:** the static verdict was confirmed empirically rather than by grep alone. The production build
was compiled, served, and loaded in instrumented headless Chromium: **2 requests, both same-origin, 0
external**. The lead re-verified each agent's top finding at `file:line` before accepting it — the
`tools/demo.mjs` delete and the `?capture=1` input-freeze both reproduced; a suspected
`?q=` → thrown-error → `insertAdjacentHTML` XSS chain was traced and **did not connect**
(`createConfig` never calls the throwing `setQuality`), so it was downgraded to a latent sink.

**Verdict: no malware, no backdoor, no covert egress, no secrets.** Load-bearing negatives, now
enforced as CLAUDE.md NEVER rules 3–5: zero `fetch`/`XHR`/`WebSocket`/`sendBeacon`/WebRTC in the tree
(the 14 apparent `fetch` hits are a GLSL function in `src/render/bloom.js`); zero
localStorage/cookies/IndexedDB/clipboard; exactly one `navigator.*` call in 68k lines (`getGamepads`);
zero `atob`/`btoa`/base64 payloads and zero zero-width/bidi/homoglyph characters across all 185 files;
zero Three.js asset loaders, corroborating the fully-procedural claim; input reads `e.code` not `e.key`,
so no character stream exists to log. All 68 lockfile entries resolve to `registry.npmjs.org` with
integrity hashes verified against the live registry; no root install scripts; no `.github/`, no git
hooks, no `.npmrc`, no `.vscode/` — **nothing executes on clone or on opening the repo**. Git history is
2 commits with nothing added-then-removed and zero dangling objects.

**Fixed:** nothing — findings recorded in `docs/KNOWN_ISSUES.md` (KI-1..KI-8) rather than patched, since
the owner asked for an assessment and the repo is kept diffable against upstream.

**Verify:** `npm run build` ✓ (145 modules → 1.63 MB, 498 kB gzip, ~6 s) · runtime boot ✓
(`__READY__`, 0 page errors, prewarm `ok:true`, 136 programs compiled) · frames rendered ✓ at `?q=low`
(world + full HUD correct; 1119 draw calls, 8.3M tris, 90 programs, 118 textures).
`tools/capture.mjs` not run — needs `npx playwright install chromium` and a real GPU.

**Learned:** all nine CLAUDE.md gotchas came out of this wave. The three that cost the most time:
`?capture=1` fakes the clock so `__RENDER_INFO__.ms` is not a frame time; the capture harness needs a
real GPU (>30 s/frame under SwiftShader at `ultra`, which silently blows the 30 s screenshot timeout);
and `npm ci` does not install Playwright browsers.
