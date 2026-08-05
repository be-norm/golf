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
   Two sanctioned exceptions, both outside a live log rather than edits within one:
   round IMPORT (`importRound`) atomically replaces an entire round's validated log — a
   restore; and a first-tee handicap adjustment (`roundRepo.setCourseHandicap`) rewrites
   `Round.players` only while the log is EMPTY, enforced in the transaction, so nothing
   derived can change under it.
   Game-event payloads are validated against each engine's `eventKinds` schema in
   `deriveRound`; events that fail validation are inert.
3. **Money is integer cents.** Every game settlement must be zero-sum (asserted in tests).
4. **Rounds are self-contained.** `Round.courseSnapshot` freezes the course at tee-off;
   editing a course never changes a played round.
5. **Offline is the default.** The app must be fully functional with zero connectivity;
   Supabase (course library, round archive) is opportunistic only.
6. **Handicaps carry a dimension.** `RoundPlayer.courseHandicap` is the handicap for the course
   *as rated*: 18-hole on an 18-hole course, 9-hole on a 9-hole course (halve the INDEX, per WHS —
   `courseHandicapForTee`). Scaling it to the holes actually played is the engine's job
   (`nineOfEighteen` halves the course handicap for 9 of 18 — a different adjustment, because
   rating − par is an 18-hole term). A tee's rating shares that dimension: a 9-hole card carrying
   an 18-hole rating inflates every handicap by ~30, so imports normalize it (`normalizeTeeRatings`).
7. **Sync-ready IDs.** Locally-minted entity IDs are UUIDv7; rows carry `updatedAt`.
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

## Native app (planned — read before touching PWA or auth surface)

Store distribution via **Capacitor** is planned (iOS first). Plan of record:
`docs/native-app-plan.md`. `src/**` ships into the shell unchanged, so ordinary feature
work needs no adaptation — but two constraints apply to work done before the conversion:

- **Don't invest in service-worker / install UX.** Service workers do not run in
  Capacitor's iOS WKWebView; `UpdateToast` and `InstallHint` get gated off natively.
  Polish there is work that will be discarded.
- **Don't enable `VITE_GOOGLE_AUTH`.** Shipping a third-party social login obligates
  Sign in with Apple (App Store guideline 4.8). Email + guest only until that's budgeted.

One store requirement is on the *near* side of the conversion — build it web-first, where
it's easier to test: **in-app account deletion** (guideline 5.1.1(v), mandatory because the
app creates accounts).

**Auth sends no email links today, and that's what keeps it native-safe.** Confirmation is
off (`supabase/config.toml`: `enable_confirmations = false`), so `signUp` returns a session
directly, and there's no password-reset flow. A link can't return a session to
`capacitor://localhost`, so if you ever add email confirmation, password reset, or email
change, use a 6-digit code (`{{ .Token }}` + `verifyOtp`) rather than a link.

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
  the capability). Course DATA stays global/shared, but which courses you SAVED is owned —
  see `saved_courses` below. Dexie v2 `.upgrade()` backfilled existing rows to `LOCAL_USER`.
- **Claim-on-login.** Signing in offers (opt-in) to rewrite this device's guest rows to the
  auth uid in one transaction, then push them — this is how pre-auth data moves into an
  account (`claimLocalData`, `src/remote/sync.ts`).
- **Sync is snapshot + outbox, best-effort.** Only signed-in, **completed** rounds, the
  roster and the **saved course library** sync; live rounds stay on their device. Push/delete
  go through the Dexie `outbox` (`src/remote/outbox.ts`); `pull` (`sync.ts`) is additive +
  last-write-wins by `updatedAt` with soft-delete tombstones. round_archives is keyed by
  `(user_id, round_id)`; a re-push never clears a tombstone (`deleted_at` omitted from the
  upsert), so "removed" is `deleted_at >= updated_at` — and timestamps are compared as
  instants (`Date.parse`), never strings: local stamps end `Z`, Postgres returns `+00:00`.
- **`saved_courses` is the user's library: DATA IS SHARED, MEMBERSHIP IS OWNED.** `courses`
  caches scorecards — the same card serves everyone who plays there, so it has no owner and
  is never scoped. Which courses are YOURS is a different, owned fact: it follows you between
  devices and must not leak to whoever signs in on your phone next. Locally the split is
  `courses` (shared cards) + `saved_courses` (`[userId+courseId]`, `LOCAL_USER` sentinel +
  claim-on-login, like rounds and players); remotely `saved_courses(user_id, course_id, data)`.
  The remote row **copies the card** rather than foreign-keying `courses` (that table is the
  shared *discovery* library, not a superset of what people save — live-API imports are never
  upserted there), and `course_id` is **text**, not uuid (GolfCourseAPI mints `gca:9` ids; a
  uuid column rejected them and silently killed the first attempt's entire push).
  **Membership writes live in `CourseRepo` and nowhere else** — each mutator writes the
  `saved_courses` row and its outbox op in the SAME transaction (the `EventStore.append`
  rule), with the guest gate inside, so membership and its push cannot drift; ESLint blocks
  `db.saved_courses` outside `src/db`. The pull-side `applyRemote*` pair is the sanctioned
  non-enqueueing exception. `saved_courses.updated_at` is the MEMBERSHIP clock (when this
  user saved it), never the card's own stamp. Removing the last membership on a device also
  GCs the cached card (unbounded `db.courses` growth is what triggers iOS quota eviction,
  which takes live round logs with it).
- **Editing a course you don't own FORKS it (MAI-78).** Ownership is `Course.createdBy`, not
  `source` — an imported copy of another golfer's course is `source:'user'` but still theirs,
  and RLS refuses updates to rows you didn't create. Your own card updates in place and
  republishes; anyone else's silently becomes a new user-owned course (fresh UUID, revision
  0), membership moves to the fork, and the list screen states the consequence after the
  fact. Never a modal: it would offer an "overwrite" the server rejects.
- **RLS is `auth.uid() = user_id`** on `round_archives` + `players`; `courses` SELECT is
  granted to `anon, authenticated` so signed-in users keep library access. Deleting a whole
  round/player is outside the append-only event invariant (#2 governs edits *within* a round).
- **Account deletion is a hard delete with a 30-day data archive** (`/account` →
  `delete-account` Edge Function). Required by App Store guideline 5.1.1(v). Full design +
  admin reinstatement runbook: `docs/account-deletion.md`. A new user-owned table must be
  handled in FOUR places or deletion silently rots: cascade from `auth.users`, archived by
  `delete-account`, a restore step in the runbook, and dropped by `wipeUserData`
  (`src/db/wipe.ts`). Two invariants that are easy to break by accident:
  - **`deleted_account_archives` is service-role only** — RLS on, *no* policies, privileges
    revoked from `anon`/`authenticated`. It holds the data of people who asked to be
    forgotten. Never add a policy to make it client-readable.
  - **The purge is compliance, not housekeeping.** `pg_cron` plus a GitHub Actions fallback
    both call `purge_deleted_account_archives()`. If neither runs, retention becomes
    indefinite — which is the "deactivate instead of delete" pattern the guideline names as
    insufficient. Disabling them breaks compliance, not tidiness.
  - Only **completed** rounds ever reach the server, so only those can be reinstated; a live
    round is destroyed with the local wipe. Don't let UI copy promise more.

## UI conventions

- **The bar recaps, the sheet accounts.** Every stroke-decided game's pinned-bar
  summary shows the LATEST decided hole ("H4 · Rob wins 2 skins") via
  `latestHoleSummary` (core/summary.ts) → `summaryParts`, never the running
  aggregate (that's the standings sheet). New games follow this by default.
  Match-play games (Nassau) are the documented exception: their bar shows live
  bet status because the stakes are the running match, not a single hole.
- **A decided bet is a won bet, everywhere at once.** A Nassau bet is settled
  the moment a side is up more holes than the bet has left — not when its holes
  run out. It then reports in golf's notation (`Ann wins 3&2`, or `2 up` for one
  that went the distance), its margin FREEZES there, it stops being pressable,
  and the money moves on that hole. All of it comes from one formatter
  (`closeMargin`) so the bar, the ledger, the standings detail, the settle
  screen and the share card cannot disagree. The margin is ONE UNBREAKABLE
  TOKEN — bare `3&2`, and a non-breaking space in `2 up` — because the share
  card's painter word-wraps on spaces and would strand the "up" on its own
  line. **Never quote a to-play count off a hole nobody played:** a bet can run
  out of room on an unplayed hole (finishing early finalizes the rest of the
  card at once), and "won 2&1" about a match whose last thirteen holes never
  happened is a fabrication — it degrades to the plainly true `2 up`. Skins'
  equivalent is the carry that can no longer be won: it is declared dead rather
  than left reading as "carried" onto a hole that doesn't exist (MAI-38).
- **`settlement.lines` is money that MOVED; narration goes on `notes`.** A game
  with something to say on the settle surface that isn't a payout ("3 skins died
  unwon") puts it in `GameDerivation.notes`, rendered below the money and visibly
  apart from it. A zero-cent settlement line instead makes `lines.length === 0` —
  the settle panel's "No money moved." signal — false on exactly the round it was
  written for, and hands every future consumer a phantom row to special-case.
  Same rule as `GamePanel.kind`: carry the intent, don't overload a field. A
  property test enforces it (`replay.test.ts`); Wolf is a known, commented
  exception pending MAI-75 (MAI-40).
- **The ledger explains WHY, not just what.** Each engine's `holeSummary` states
  the outcome, then explains the cause of anything non-obvious on a "↳ "
  continuation line (birdie→flip, carry→multi-skin, 2-down→press, lone/blind→
  Wolf points). A reader should never have to ask why a result happened.
- **Availability pulls, recommendation pushes — never the same channel.**
  `requiredInputs`/`InputRequest` is for genuinely BLOCKING inputs (Wolf's pick:
  the hole can't compute without it) and interrupts. Optional player-initiated
  actions go through `availableActions`/`GameAction`, park behind a button, and
  only *badge* when the game's convention says act now (`recommended`). Mixing
  them is how Nassau ended up nagging "Press?" on every hole while never saying
  why (MAI-34): a thing that's legal most of the time will interrupt most of the
  time. A `GameAction` carries its own argument — `detail` (why it's offered)
  and `effect` (what taking it creates).
- **The share card is painted, not screenshotted.** `Share` on the settle screen
  produces a PNG drawn by hand onto a canvas (`paintSummaryCard.ts`), never a
  DOM capture — rasterising the live screen means `foreignObject`, and so means
  fighting Tailwind v4's `oklch()` colours, the woff2 files Vite leaves
  un-inlined, and iOS Safari, for a design that is rectangles and text.
  `buildSummaryCard` (`summaryCard.ts`) is the single derivation behind the
  settle screen AND the painter — both render that one model, so their numbers
  can't drift. (`ScorecardScreen` still derives its own grid, and marks strokes
  from the game the user has selected rather than the model's first-net-game
  rule; that's why the image names the game in its stroke note.) The model
  carries its own display discriminators — `GamePanel.kind` says ledger-vs-list
  rather than letting a renderer infer layout from whether a label is empty.
  Keep the split — numbers in the model (tested), placement
  in the painter (jsdom has no canvas, so it is deliberately untested; don't add
  a polyfill dependency to "fix" that). `shareImage.ts` is the only file that
  touches the Web Share API, and the swap point for `@capacitor/share`.

## Testing conventions

- Every game engine ships hand-verified golden scorecard tests (TypeScript, in
  `src/engine/games/<game>/<game>.test.ts`: scripted scores/events via the test harness,
  asserted hole results + settlements). The hand-derivation lives in the test comments.
- fast-check property tests guard: zero-sum settlements, replay determinism,
  retraction equivalence, handicap allocation invariants.
