# Golf — game tracker for golf money games between friends

Installable offline-first PWA. One scorekeeper phone per group enters hole-by-hole scores;
the app computes all game standings/payouts (Skins, Nassau, Wolf, Vegas in MVP).
Full plan/architecture history: see `docs/` and the games catalog in `docs/games-catalog.md`.

## Commands

- `pnpm dev` — dev server
- `pnpm test` — vitest run (two projects: `engine` in node env, `app` in jsdom)
- `pnpm typecheck` / `pnpm lint` / `pnpm build`

## Architecture invariants (do not violate)

1. **`src/engine/**` is pure TypeScript.** No React, DOM, Dexie, network, or app-layer imports —
   only relative engine imports + `zod`. Enforced by ESLint (`no-restricted-imports`/`globals`)
   and by the `engine` vitest project running in node environment.
2. **Event sourcing.** A round is an append-only event log (`score/set`, `score/clear`,
   `game/event`, `round/completed`, `round/reopened`, `meta/retract`). Standings are derived
   by full replay through pure reducers. Never mutate or delete events — undo is a
   `meta/retract` compensation event. `EventStore.append` is the only write path for events.
   One sanctioned exception: round IMPORT (`importRound`) atomically replaces an entire
   round's validated log — a restore, never an edit of a live log.
   Game-event payloads are validated against each engine's `eventKinds` schema in
   `deriveRound`; events that fail validation are inert.
3. **Money is integer cents.** Every game settlement must be zero-sum (asserted in tests).
4. **Rounds are self-contained.** `Round.courseSnapshot` freezes the course at tee-off;
   editing a course never changes a played round.
5. **Offline is the default.** The app must be fully functional with zero connectivity;
   Supabase (course library, round archive) is opportunistic only.
6. **Sync-ready IDs.** Locally-minted entity IDs are UUIDv7; rows carry `updatedAt`.
   Exception: courses imported from OpenGolfAPI keep the provider's UUID as their id —
   deliberate, so the same course dedupes across devices and the shared library
   (provenance lives in `source`/`source_id`). Tee-set ids are course-scoped slugs.

## Layout

- `src/engine/core/` — events, replay, handicap allocation, money; `src/engine/games/<game>/` —
  one engine per game + golden fixtures; `src/engine/catalog.ts` — GameEngine registry
- `src/db/` — Dexie schema + repos; `src/features/` — screens; `src/components/` — primitives
- `data/courses/` — seed scorecards (bundled into app + used by Supabase seed)
- `supabase/` — migrations + seed/import scripts

## Infra

- GitHub repo `be-norm/golf`; CI + GitHub Pages deploy on green main (`.github/workflows/ci.yml`)
- Deployed at https://be-norm.github.io/golf/ (Vite `base: '/golf/'` — keep SW scope in sync)
- Supabase project `golf`, ref `xbdsssnjphbxequhlazu`, org `ben-personal` (free tier).
  DB password in untracked `.env.local`. Course data source: OpenGolfAPI (ODbL — keep
  attribution + provenance columns; publish transformed dump).

## UI conventions

- **The bar recaps, the sheet accounts.** Every stroke-decided game's pinned-bar
  summary shows the LATEST decided hole ("H4 · Rob wins 2 skins") via
  `latestHoleSummary` (core/summary.ts) → `summaryParts`, never the running
  aggregate (that's the standings sheet). New games follow this by default.
  Match-play games (Nassau) are the documented exception: their bar shows live
  bet status because the stakes are the running match, not a single hole.

## Testing conventions

- Every game engine ships hand-verified golden scorecard tests (TypeScript, in
  `src/engine/games/<game>/<game>.test.ts`: scripted scores/events via the test harness,
  asserted hole results + settlements). The hand-derivation lives in the test comments.
- fast-check property tests guard: zero-sum settlements, replay determinism,
  retraction equivalence, handicap allocation invariants.
