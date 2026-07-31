# COD Fable browser performance audit

## Verdict

The low frame rate on an M1 Mac is credible and expected from the current
rendering budget. This is not a “bad laptop” issue: the game renders a serious
multi-target HDR pipeline, cascaded shadows, procedural atmosphere, AI, and
large instanced geometry in one frame. The good news is that the codebase already
has the right quality seams; we can improve the experience without stripping the
game’s look.

## What is already good

- Quality presets already control render scale, shadow maps/cascades, TAA, GTAO,
  SSR, volumetrics, motion blur, anisotropy, particle capacity and decal capacity.
- The renderer caps device pixel ratio at `1.5`, avoiding the full 2× Retina cost.
- FX uses fixed-capacity GPU-instanced rings rather than allocating per frame.
- The project explicitly precompiles material permutations to avoid the worst
  mid-game shader stalls, and recent boot changes make that pre-warm opt-in so it
  cannot hold first paint hostage.

## Highest-impact findings

| Priority | Finding | Evidence | Player impact | Safe next experiment |
| --- | --- | --- | --- | --- |
| P0 | Internal render resolution is still expensive on Retina | `RenderSystem.resize()` uses DPR up to 1.5 and medium quality renders at 0.85 scale | Several HDR render targets and post passes run around 3 MP on a 1512×982 M1 display | Add a user-visible **Performance** preset with a 0.70–0.75 internal scale; compare screenshots before shipping |
| P0 | Medium enables a dense post stack | Medium enables TAA, GTAO, volumetrics and motion blur; all are resized with the HDR target | Frame time is dominated by screen-space/full-screen work even when little is happening | Profile one feature toggle at a time, beginning with volumetrics and motion blur |
| P1 | The level is heavy before post-processing begins | Runtime reports roughly 612k static triangles, 1.15m instanced triangles and 7,994 instances | Geometry/shadow traversal remains substantial even when standing still | Measure shadow-caster and draw-call costs; introduce distance LOD only where screenshots show no material loss |
| P1 | AI and material generation make startup feel broken | Safari logs show AI material prewarm around 7.8 s; garrison/nav are built at boot | Long black/boot periods are interpreted as crashes | Keep the new command lobby and boot status; move only nonessential, non-gameplay preparation behind first interaction after profiling |
| P2 | Default quality selection is static | URL defaults to medium, but it does not adapt after the first measured frames | M1-class devices can stay in a frame-time regime that feels stuttery | Add an opt-in adaptive scaler that changes only internal resolution after sustained P95 pressure |

## Do not change blindly

- Do not globally turn off shadows, materials, the atmosphere, or the viewmodel.
- Do not reduce every asset/mesh at once; that destroys the reference point and
  makes regressions impossible to attribute.
- Do not trust average FPS alone. The user experiences P95/P99 hitches, especially
  when firing, entering new areas, or watching AI spawn.

## Measurement protocol

Target an M1-class Mac at a 1280×720 logical viewport first, then validate at the
actual Retina display size.

| Tier | Success condition |
| --- | --- |
| Preferred | P50 frame time ≤16.7 ms (60 FPS) and P95 ≤25 ms |
| Acceptable | P50 ≤25 ms (40 FPS) and P95 ≤33 ms |
| Not shippable as default | P95 >50 ms, multi-second shader stalls, or browser reload/crash |

Use `tools/perf.mjs` for repeatable frame-time distribution checks. Run one change
at a time at `low`, `medium`, and the proposed Performance preset; record P50,
P95, draw calls and triangles. Pair each accepted performance change with the
existing screenshot/pixel-diff tooling so quality concessions are deliberate.

## Next implementation sequence

1. Add a **Performance** preset exposed in the lobby/settings, tuned for Apple
   silicon rather than named “low.”
2. Benchmark it against medium, isolating internal resolution before disabling
   any visual system.
3. Gate the most expensive full-screen pass using measured frame time, with a
   slow recovery window to avoid resolution flicker.
4. Profile AI update cost separately from rendering while in the command lobby;
   pause nonessential combat decisions before a session begins.
5. Ship only changes that meet the screenshot and P95 gates.
