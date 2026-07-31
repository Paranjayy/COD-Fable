# COD Fable Launch Surface and Performance Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the game a distinctive FPS lobby, an honest first mode-selection shell, durable project discovery links, and a measured path to improve M1-class performance without lowering the game’s visual bar indiscriminately.

**Architecture:** The home screen is a self-contained DOM overlay owned by the UI subsystem. It pauses player control until a mode is selected, then configures the existing HUD/session presentation and requests pointer lock; it does not fork or mutate rendering, AI, physics, or weapon internals. Performance work begins with reproducible measurements and a written audit, before any renderer budgets are changed.

**Tech Stack:** Vite, vanilla ES modules, Three.js, DOM/CSS, Playwright smoke harness, Vercel.

---

### Task 1: Preserve and document the known-good state

**Files:**
- Create: `FABLE_IDEAS.md`
- Modify: `README.md`
- Git ref: `backup/known-good-a8e849c`

- [x] **Step 1: Create and push a backup branch**

Run: `git branch backup/known-good-a8e849c a8e849c && git push origin backup/known-good-a8e849c`

Expected: the remote branch resolves to commit `a8e849c`.

- [ ] **Step 2: Add project-facing links to the README**

Add live site, project repository, upstream source, original X demo, newsletter, and a DeepWiki link using `https://deepwiki.com/Paranjayy/COD-Fable`.

- [ ] **Step 3: Commit the documentation slice**

Run: `git add README.md FABLE_IDEAS.md && git commit -m "docs: add project links and roadmap"`

### Task 2: Build a lobby that hands off cleanly to the existing game

**Files:**
- Create: `src/ui/home.js`
- Modify: `src/ui/index.js`
- Modify: `src/ui/style.js`
- Modify: `src/main.js`

- [ ] **Step 1: Add a DOM-only home screen**

Create a `HomeScreen` class with three explicit actions: `Operation`, `Practice`, and `Settings`. It must use native buttons, support keyboard activation, have visible focus states, and not create Three.js objects or allocate inside frame updates.

- [ ] **Step 2: Connect selection to UI state**

Start player control only after a mode selection. `Operation` should label the HUD `OPERATION`; `Practice` should label the HUD `PRACTICE`; settings opens the existing pause/settings surface without requesting pointer lock.

- [ ] **Step 3: Style the lobby as an industrial tactical briefing, not a generic dashboard**

Use a sparse left-anchored command column over the live procedural scene, warm signal-orange accents, semantic status text, and a restrained entrance. Respect reduced-motion preferences and narrow viewports.

- [ ] **Step 4: Test the interaction seam**

Use Playwright to assert that the lobby is present after boot, `Practice` hides it, and the HUD mode changes to `PRACTICE`.

- [ ] **Step 5: Commit the lobby slice**

Run: `git add src/ui/home.js src/ui/index.js src/ui/style.js src/main.js && git commit -m "feat: add tactical game lobby"`

### Task 3: Produce a performance audit before optimization

**Files:**
- Create: `PERFORMANCE_AUDIT.md`
- Read: `src/render/index.js`, `src/core/config.js`, `src/fx/index.js`, `src/ai/index.js`

- [ ] **Step 1: Record the verified bottlenecks and existing safeguards**

Document internal render resolution, render targets, shadow cascades, AI/material startup, particle budgets, shader pre-warming, and the current browser startup findings.

- [ ] **Step 2: Establish an M1-friendly performance target**

Define `60fps target / 33ms fallback` at a 1280×720 logical viewport; require P50/P95 frame-time measurements before and after each change.

- [ ] **Step 3: Recommend bounded experiments, not a quality massacre**

Prioritize adaptive render scale, an explicit Performance quality profile, temporal/SSR cost gates, and AI/FX budget profiling. Require screenshot comparison before any visual-quality trade-off ships.

- [ ] **Step 4: Commit the audit**

Run: `git add PERFORMANCE_AUDIT.md && git commit -m "docs: add browser performance audit"`

### Task 4: Verify and publish only if viable

**Files:**
- Verify: `package.json`, production build, Vercel deployment

- [ ] **Step 1: Run static build**

Run: `npm run build`

Expected: Vite completes without errors.

- [ ] **Step 2: Run browser smoke test**

Run a Playwright test against the built or local Vite app. Expected: the lobby appears, a mode can be selected, the game canvas remains present, and there are no page errors.

- [ ] **Step 3: Push and deploy**

Run: `git push origin main && vercel --prod --yes`

Expected: Vercel reports `READY`; verify the live HTML contains the current asset hash.
