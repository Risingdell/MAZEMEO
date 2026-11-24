# CLAUDE.md — Forest Escape PvP

8-player procedural mountain-forest maze race. TypeScript + three.js + Node. See README.md and docs/PLAN.md.

## Commands
- `npm test` — vitest (must pass before finishing any task)
- `npm run typecheck` — strict tsc (must be clean)
- `npm run dev` — viewer at :5173 (`?seed=N`, `?cam=p1..p8` ground view, `?time=`, `?weather=`, `?quality=low`)
- `npm run survey` — 300-seed stats; run after changing generator/config tuning
- `npm run maze -- <seeds>` — quick stats

## Rules
- `packages/maze-core` must stay **deterministic and engine-free**: no DOM, no three.js, no `Math.random`, no `Date`. All randomness goes through `Rng` / `fork(label)`. Any change to generation output changes `mazeChecksum`, so call it out.
- Core must run under Node's type stripping: erasable TS syntax only (no enums, namespaces or parameter properties). Imports use `.ts` extensions.
- Tuning lives in `config.ts` (`DEFAULT_CONFIG`); tests read thresholds from it.
- The viewer imports core via the `@mazemeo/maze-core` alias (vite.config.ts + tsconfig paths).
- Visual style is an original Japanese mountain forest. Use only original/licensed assets; never extract or copy content from other games.
- Viewer code: everything is procedural (no downloaded art or audio). Foliage materials go through `applyWind` in env/shared.ts; shared env uniforms live in `env`. Physics is Rapier: heightfield takes cell counts (size−1), column-major, rows along Z.
- Review assets in the Asset Lab (`/lab.html`, see README): far cheaper than the full game. Verify visual changes with headless Edge screenshots (`msedge --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --screenshot=... "http://localhost:5173/?seed=42&cam=p1&quality=low"`). The dev machine has about 7 GB of RAM and is often near its memory limit. Check commit headroom first, use a small window (720x450) with `--renderer-process-limit=1`, and always kill the headless Edge processes afterwards; orphans caused an out-of-memory crash once.
