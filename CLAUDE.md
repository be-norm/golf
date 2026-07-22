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
- Deployed at https://golf.mainspring.fyi/ via GitHub Pages custom domain (Vite `base: '/'`;
  `public/CNAME` pins the domain across Actions redeploys — keep SW scope in sync)
- Supabase project `golf`, ref `xbdsssnjphbxequhlazu`, org `ben-personal` (free tier).
  DB password in untracked `.env.local`. Course data source: OpenGolfAPI (ODbL — keep
  attribution + provenance columns; publish transformed dump).

## Auth & sync

- **Guest-first, not login-walled.** Supabase Auth (email/password; Google is behind
  the `VITE_GOOGLE_AUTH` build flag, off until its OAuth client is configured). The app
  stays fully usable signed-out — offline-first invariant #5 holds. `AuthProvider`
  (`src/auth/`) is the single source of truth for identity and gates the routed outlet on
  an initial-session `loading` flag (no guest flash for a signed-in user).
- **Ownership dimension.** `Round`/`Player` carry `userId`; signed-out ("guest") rows use
  the sentinel `LOCAL_USER = '@local'` (`src/db/ids.ts`) — a real string, since IndexedDB
  omits `undefined`-keyed rows from compound indexes. Repos scope **lists** by userId
  (`[userId+startedAt]` / `[userId+name]`); **reads-by-id stay unscoped** (an owned id is
  the capability). Courses stay global/shared. Dexie v2 `.upgrade()` backfilled existing
  rows to `LOCAL_USER`.
- **Claim-on-login.** Signing in offers (opt-in) to rewrite this device's guest rows to the
  auth uid in one transaction, then push them — this is how pre-auth data moves into an
  account (`claimLocalData`, `src/remote/sync.ts`).
- **Sync is snapshot + outbox, best-effort.** Only signed-in, **completed** rounds and the
  roster sync; live rounds stay on their device. Push/delete go through the Dexie `outbox`
  (`src/remote/outbox.ts`); `pull` (`sync.ts`) is additive + last-write-wins by `updatedAt`
  with soft-delete tombstones. round_archives is keyed by `(user_id, round_id)`; a re-push
  never clears a tombstone (`deleted_at` omitted from the upsert).
- **RLS is `auth.uid() = user_id`** on `round_archives` + `players`; `courses` SELECT is
  granted to `anon, authenticated` so signed-in users keep library access. Deleting a whole
  round/player is outside the append-only event invariant (#2 governs edits *within* a round).

## UI conventions

- **The bar recaps, the sheet accounts.** Every stroke-decided game's pinned-bar
  summary shows the LATEST decided hole ("H4 · Rob wins 2 skins") via
  `latestHoleSummary` (core/summary.ts) → `summaryParts`, never the running
  aggregate (that's the standings sheet). New games follow this by default.
  Match-play games (Nassau) are the documented exception: their bar shows live
  bet status because the stakes are the running match, not a single hole.
- **The ledger explains WHY, not just what.** Each engine's `holeSummary` states
  the outcome, then explains the cause of anything non-obvious on a "↳ "
  continuation line (birdie→flip, carry→multi-skin, 2-down→press, lone/blind→
  Wolf points). A reader should never have to ask why a result happened.

## Testing conventions

- Every game engine ships hand-verified golden scorecard tests (TypeScript, in
  `src/engine/games/<game>/<game>.test.ts`: scripted scores/events via the test harness,
  asserted hole results + settlements). The hand-derivation lives in the test comments.
- fast-check property tests guard: zero-sum settlements, replay determinism,
  retraction equivalence, handicap allocation invariants.
