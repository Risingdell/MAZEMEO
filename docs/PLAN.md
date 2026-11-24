# Forest Escape — Production Plan

Engine decision (2026-11-23): **three.js + TypeScript**, Node authoritative server.
Reason: shared deterministic `maze-core` on server and client, runs in the browser (no install), and the toolchain is already on the dev machine. Unreal/Unity can still consume `maze-core` output later (seed → JSON) if the project moves engines.

Visual direction: an original Sengoku-era Japanese mountain forest (bamboo, maple, cedar shrines, bog, rocky summit) with strong landmark clarity. Use only original or licensed assets (Fab/Quixel, Kenney, Poly Haven, commissioned art). Never use assets or level layouts extracted from other games.

## Phase 0–1 — Foundations + maze generator ✅ (done)

- [x] Monorepo (`packages/maze-core`, `apps/viewer`), strict TS, Vitest
- [x] Deterministic RNG/noise; checksum for client/server agreement
- [x] Generator v2: planar trails, loops, terrain, climb/grapple edges, biome regions, fair spawns, tool caches
- [x] Walk field (collision + height), shared by server and client
- [x] Maze Lab viewer: overview, stats, fairness bars, ground view, walk mode
- [x] 26 tests across 60 seeds; 300-seed survey script

## Phase 2 — Landscape pipeline (8–10 wk) — in progress

- [x] Terrain splat textures (dirt / moss / leaf litter / rock / mud), height blending, triplanar rock
- [x] Bog water shader, wind sway on foliage, falling leaves (botanical leaf art), GPU blade grass and reeds
- [x] Sky, sun path, clouds, weather system (rain, mist, storm + lightning), wetness and puddles
- [x] Chunked instancing with frustum culling; Low/High quality setting
- [x] Rapier physics: terrain, colliders, pushable props, throwable stones
- [x] First-person hands view model (realistic proportions); procedural ambience and footstep audio; Asset Lab page
- [ ] Real models (glTF): bamboo, maple, cedar, reeds, rocks, torii, lanterns, shrine ruins; 3 LODs each
- [x] Maple Ravine art pass: tall autumn hardwoods, understory maples, bracken, granite boulders, leaf carpet
- [x] Cinematic post: height mist with sun glow, light shafts, bloom, colour grade; golden-hour sun alignment
- [x] Ravine landmark: stepped waterfall + pool by the P6 trail
- [x] Shrine region as a mountain pine forest (ponderosa/lodgepole, mossy banks, shrubs, granite); snow-capped range on the horizon; leather-gloved hands
- [ ] Landmarks for the other regions (pagoda, giant maple, fallen bridge); same art pass for bamboo/marsh/summit
- [ ] Performance budget: 60 fps on a mid laptop GPU at 1080p (profile on real hardware)
- [ ] Grapple anchor props placed on grapple edges; climb ledges on climb edges

## Phase 3 — Character & traversal (6–8 wk)

- [x] Third-person over-the-shoulder camera with collision; V toggles first person
- [x] Procedural explorer model + procedural locomotion animation; stamina; tool cache pickup
- [x] HUD: explored-trail compass map, stamina/tools/noise icons

- Third-person controller on the walk field, camera collision
- Climb (slow, noisy) and grapple (fast, exposed) on matching edges
- Crouch stealth in tall grass/reeds; footstep noise by surface
- Animation: licensed/mocap set, blend trees

## Phase 4 — Combat & tools (6–8 wk)

- Melee: light/heavy, block + timed parry, stamina
- Tools: smoke bomb, snare trap, grapple charge, scout kite (temporary region reveal)
- Kill → reveal victim's region + neighbours (`regions[i].neighbors`)

## Phase 5 — Networking (8–12 wk)

- Node authoritative server (WebSocket/WebTransport), 20–30 Hz tick
- Server sends `{seed, configVersion, checksum}`; clients regenerate and verify
- Client prediction + reconciliation; lag-compensated hits
- Server validates movement with `isWalkable` / `heightAt`
- Lobby, matchmaking, reconnect

## Phase 6 — Game loop & UI (4–6 wk)

- Fog-of-war minimap, match timer, results, spectate after death

## Phase 7 — Audio/VFX/polish (6–8 wk)

## Phase 8 — Playtests, balance, optimisation (8–12 wk)

## Phase 9 — Launch prep (3–4 wk)

## Open design questions

- Ground fog density vs. landmark visibility (tune in playtests)
- Should loops be biased toward region borders (more PvP contact)?
- Respawn or elimination? (affects reveal mechanic weight)
