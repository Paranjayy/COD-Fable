# COD Fable — bold iteration ideas

This is not a feature checklist. It is a set of bets for turning the impressive
technical demo into something people return to and share.

## North star

**Make every 90-second session generate a story worth retelling.** The procedural
world is the differentiator; the game should lean into unpredictable tactical
moments rather than chase a bigger conventional multiplayer shooter.

## Best next bets

### 1. Fable Operations

A short, replayable solo operation generator: one objective, two rival factions,
and one evolving complication (blackout, sandstorm, hostage extraction, roaming
armored patrol). The level already proves combat and navigation; this adds a
reason to play a second round.

**Why it is strong:** it turns the current sandbox into a repeatable game loop
without needing servers, matchmaking, or a content team.

### 2. Ghost replay cards

After a run, create a compact shareable card: route taken, accuracy, three key
moments, and a deterministic seed link that lets another player attempt the same
operation. The seed becomes the social object, not a large video upload.

**Why it is strong:** native sharing for a browser game, and a natural public
demo hook: “beat my impossible 73-second extraction.”

### 3. The Director

Add an explicit “AI director” that controls pacing rather than only individual
enemies. It watches exposure, ammo, noise and player health, then creates lulls,
flanks, reinforcements and escapes. Players should feel hunted, not simply
surrounded by bots.

**Why it is strong:** it makes procedural systems legible as drama, which is a
more interesting AI-game claim than raw visual fidelity.

## Bigger swings

### Living district

Treat the map as a small simulated district: civilians react to gunfire, shutters
close, power cuts change sightlines, and factions contest blocks over multiple
operations. A persistent “city heat” score changes what the next run contains.

### Tactical folklore

Every seed earns a codename and a one-sentence post-action story generated from
actual events: *“The Glass Market: extraction failed after the western flank
collapsed.”* It builds identity around the runs without pretending the game is a
full open world.

### Community war table

Weekly public seeds form a global operation map. Players choose a faction, post
scores, and collectively unlock the next district condition. Keep the core game
single-player; use asynchronous competition rather than fragile real-time PvP.

## What not to do yet

- Real-time multiplayer: networking, anti-cheat and authoritative simulation
  would consume the project before it proves a replayable core.
- More guns before missions: weapon breadth does not solve the absence of a
  goal, stakes or a session arc.
- Chasing photorealism first: the procedural aesthetic is a strength when the
  combat stories are memorable.

## Proposed iteration rhythm

1. Pick one small player-visible hypothesis per iteration.
2. Build and run a focused browser smoke test.
3. Commit and push the finished slice to `main`, then deploy it.
4. Record what changed and the next question in this file or the README.

I will follow this commit/push cadence for future iterations in this repository
unless you ask me to keep work local or prepare a review-only change.

## Immediate recommendation

Start with **Fable Operations: one extraction mission with a Director-controlled
ambush**. It is the smallest bet that tests whether this can become a game rather
than a beautiful technical demo.
