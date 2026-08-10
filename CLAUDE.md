# Golf — game tracker for golf money games between friends

Installable offline-first PWA. One scorekeeper phone per group enters hole-by-hole scores;
the app computes all game standings/payouts. Seven games ship today — Skins, Nassau, Match
Play, Wolf, Vegas, Six Point and Closest to the Pin; `docs/games-catalog.md` holds those plus
every game still to come, with implementation-grade scoring math.

**The architecture of record is the invariants below** — there is no separate plan history to
consult, and this line used to promise one. `docs/` carries exactly two standing design notes
(`native-app-plan.md`, `account-deletion.md`) alongside that catalog; everything else is in
Linear (team MAI, project "Additional Games"), where each ticket says why it was built the
way it was.

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
7. **A side bet IS a peer game, and taxonomy never touches money.** A side bet is an ordinary
   `GameEngine` sitting in `round.games` next to the main game — not a child, no
   `parentGameId`. It is tagged three ways, all of them PRESENTATION ONLY:
   `meta.category` ('main'|'side'|'either') is eligibility and the default;
   `GameConfig.role` is the per-round truth (Skins is the main event one round and a $1 side
   bet the next, and only the round knows); `meta.family` groups the picker by how the bet is
   decided, with `meta.shapes` as the set of social shapes a game supports — a SET because
   Nassau is 1v1 or 2v2 by config, which is exactly why that can't be `family`'s axis.
   **`deriveRound` reads none of them, and both halves are enforced.** `role` by test —
   `catalog.test.ts` derives every registered engine three ways and the same card must settle
   identically whether its games are labelled main, side, or nothing at all. The three `meta`
   fields by ESLint: `getEngine`/`listEngines` are banned inside `src/engine/games/**`, and
   so is importing another engine (or the games barrel) — the registry is not the only door
   to a singleton's meta, and that second ban is what makes "engines never read each other"
   enforced rather than merely stated. `games/index.ts` is exempt; registering is its job.
   **`role` is DERIVED, not stamped** (`roleOf`, catalog.ts), and it takes the whole round
   because 'either' cannot be answered from the engine alone — Skins beside a Nassau is the
   side bet, Skins alone is the main event. Setup stores `role` only where something READS
   the distinction — i.e. only when the section the user picked into contradicts what `roleOf`
   derives, AND the round holds more than one game (in a one-game round `primaryGame` returns
   that game either way, the bar collapses nothing and the card groups nothing, so a stamp
   there is a value with no consumer). A round holding no `role` can be re-read by a better
   rule instead of being permanently wrong in a synced archive.
   `roleOf`'s production callers are `src/lib/gameRoles.ts` (primary game + role partition)
   and setup's role stamping; the density rules and the picker are what consume it.
   **The one-way rule:** an engine is a pure function of `(config, its own events,
   RoundContext)` and engines NEVER read each other. That purity is why the app layer has zero
   per-game branching, and why a game can be added without touching a screen. The escape hatch
   for genuine overlays (Criers & Whiners' mulligan credits, putts shared between Snake and
   Dots) is **contributing to `RoundContext` before any engine derives** — context to engines,
   never engine to engine. Design toward it; don't build it until something needs it.
   **Putts are the first planned contributor, and the line they draw is the one to keep
   (MAI-54).** An AWARD is a binary per-player, per-hole *bet* fact owned by one engine —
   the greenie, the CTP — and rides the award channel below. A PUTT COUNT is a *scorecard*
   fact owned by the round: it is a number, golfers write it on the paper card beside
   strokes, and it is true regardless of which bets are running. So putts get a round-level
   `score/putts` event feeding `RoundContext`, entered once and read one-way by Snake, Dots
   and Trouble alike — which also makes 3-putt/snake DERIVABLE rather than another button.
   Built as `score/putts` + `score/puttsClear` -> `ctx.puttsFor` (MAI-90); no engine reads
   them yet. **A round collects a shared fact because a GAME declares it reads one**
   (`meta.reads`, a `RoundFact` set), never because the user was offered a switch:
   nothing here shows putts back to you, so a Skins round asked for a number that went
   into the log and was never seen again. That declaration is also the ONLY way a game can
   require one - `validateSetup` sees config, players and siblings, never the round - so
   an engine reading a fact nobody collects would derive nothing while looking healthy.
   The rule lives in `src/lib/roundFacts.ts`; setup freezes the answer onto
   `Round.trackPutts`. `undefined` and `0` are different everywhere (a chip-in takes no
   putts). What the decision buys is that the award channel stays a binary toggle and
   never had to carry counts.
8. **Sync-ready IDs.** Locally-minted entity IDs are UUIDv7; rows carry `updatedAt`.
   Exception: courses imported from OpenGolfAPI keep the provider's UUID as their id —
   deliberate, so the same course dedupes across devices and the shared library
   (provenance lives in `source`/`source_id`). Tee-set ids are course-scoped slugs.
9. **`ctx.holesPlayed` is the hole set, and its ORDER is the only thing that sequences it.**
   A round can tee off on any hole and WRAP (`Round.startHole`, MAI-41): 18 from 10 plays
   `[10…18, 1…9]` and finishes on 9. `holesForRound` (`core/holes.ts`) is the one producer,
   the only reader of `round.holes`/`round.startHole`, and the one place a start hole the card
   lacks falls back — imports validate neither field. **Everything downstream compares
   POSITION in that list, never hole number.** `3 < 12` says nothing about which was played
   first, so "is this hole later", "how many are left", "which nine is this" and "what is in
   this prefix" are all index questions: `spanFrom`, `segmentSpans`' slice halves, Nassau's
   `Bet.startIdx`, the ledger's `positionOf`. **Getting one wrong is invisible to every
   order-blind property** — zero-sum, determinism and retraction equivalence all hold while
   nassau settles its front bet with the last nine holes walked. So the enforcement is
   `arbitraryRotationPair` (`test/arbitraries.ts`): the same golf dealt twice, once wrapped
   and once on a card renumbered so the identical walk reads 1–18, asserting every engine
   settles both the same AND lands each payment on the same hole of the walk. It is checked
   by reintroducing the bugs — it catches the nassau-halves and ledger-prefix ones. It does
   NOT catch the match kit's old `filter(h >= startHole)`, because that costs no money:
   `holesRemaining` drives the to-play count, the dormie test and the close note, while
   settlement is gated on `closedAt` off the always-positional `toPlayAfterIn`. Narration
   bugs of that shape need goldens (`matchPlay.test.ts` MP12), not properties. Setup offers
   the picker on 18-hole rounds only, and `startHole` is stored only when it differs from the
   range default; those two together are what keep the change revertible (`holesForRound`).

## Layout

- `src/engine/core/` — events, replay, handicap allocation, money, plus the shared game kits
  (`match` for match play + the one `closeMargin`, `points` for rank-points/points-money,
  `standings`); `src/engine/games/<game>/` —
  one engine per game + golden fixtures; `src/engine/catalog.ts` — GameEngine registry
- `src/db/` — Dexie schema + repos; `src/features/` — screens; `src/components/` — primitives;
  `src/lib/` — app-layer helpers shared across features (`date.ts` is the fixed, locale-independent
  `18 Jul 2026` format shared by the share card and course versions; the round lists still use
  `toLocaleDateString`, so this is not yet app-wide. `gameRoles.ts` is the one primary-game /
  role-partition rule — see UI conventions). `src/lib/**` is inside the engine-purity denylist
  (`eslint.config.js`) and its tests are inside the `app` vitest project: both lists enumerate
  directories, so a new top-level directory has to be added to each or it is silently unguarded
  and its tests silently never run.
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
  `db.saved_courses` outside the sanctioned db files. The pull-side `applyRemote*` pair is
  the sanctioned non-enqueueing exception. `saved_courses.updated_at` is the MEMBERSHIP
  clock (when this user saved it), never the card's own stamp — and every server write is
  staleness-gated (`lte` on `updated_at`; the push is insert-if-absent + gated update, the
  tombstone carries the REMOVAL instant), so an op flushing late can never rewind a newer
  write from another device. `flushOutbox` no-ops signed-out: owner-scoped ops can't succeed
  as anon, and a 0-row tombstone UPDATE would read as success and destroy the removal.
  Removing the last membership on a device also GCs the cached card (unbounded `db.courses`
  growth is what triggers iOS quota eviction, which takes live round logs with it). There is
  deliberately NO silent adoption of the pre-v3 library — an automatic claim stamps fresh
  clocks over the account's tombstones and resurrects courses removed elsewhere; the claim
  prompt (which counts courses) is the consented migration path.
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
  The **collapsed side-bets row** is the second exception (MAI-50): with a main
  game and 2+ side bets the bar folds them into one aggregate ("SIDE BETS ·
  Ben +$7 · Rob −$4"), which IS a running total, because nothing else compresses
  N games into one line — the per-hole detail is one tap away in the sheet.
  Collapsing happens only when it saves a row (`shouldGroupSideBets`): a lone
  side bet keeps its own row and its recap, and a round of only side bets shows
  them expanded.
  **The sheet accounts, but it leads with what just happened** (MAI-84): each
  game's block is recap → player cards → notes, because opening it to a column
  of running money buries the hole you are standing on. Universal, since
  `holeSummary` is a per-hole recap by contract for every game. It stays
  `holeSummary(currentHole)` and NOT `latestHoleSummary` — walking back to 3
  must recap 3; the latest DECIDED hole is the bar's job, and on the frontier
  (where the sheet is almost always opened) they are the same hole.
- **One default primary game, shared by every surface** (`src/lib/gameRoles.ts`).
  `primaryGame(round)` = first NET main game → first main game → `games[0]`;
  `strokeGame(round)` is that game only when it allocates strokes. Three
  surfaces used to answer this three different ways, so a round whose `games[0]`
  was gross showed no scorecard underlines while the share card underlined
  something else, and a cheap net side bet could capture the scoring screen's
  stroke dots. The scorecard still honours the user's chip selection ON TOP of
  that default. `roleOf` is what makes it work, and this is its first
  production caller.
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
  **The affordance owns no vocabulary** (MAI-47): button, sheet header, explainer
  and empty state all come from the offering engine's `meta.actions`
  (`verb`/`plural`/`blurb`/`emptyState`), and the recommendation badge from the
  action's own `recommendedReason`. `ScoringScreen` uses one game's words when
  exactly one game is offering and neutral wording otherwise. A game that offers
  actions and declares no copy is a `catalog.test.ts` failure, not a fallback.
- **An answered pull STAYS ON SCREEN** (MAI-84). `InputRequest.answered` carries
  the option in effect plus the `lines` the game states it with; the screen turns
  the gold interrupt into a quiet card with an `Adjust` button that reopens the
  same options, current answer engaged. Same doctrine as `GameEventOffer.taken`,
  and it closes the hole that made Wolf's teams unreadable AND unfixable: they
  vanished on the tap, and the header undo only ever reaches the log's tail, so
  one score entry later a mistapped partner was permanent. Re-answering is one
  more event — every input reducer is last-write-wins per hole — which is why
  `answered` carries no `undoEventIds`, and why the screen must NOT emit when the
  option already in effect is tapped — an input has ONE answer at a time, so
  that is the guard, and it subsumes the duplicate one. "In effect" means what
  was SENT, not what derived: the derivation lags a write by an append, a live
  query and a re-derive, so comparing against it drops a revert made inside that
  window. The intent is owned by event IDENTITY and released when the event
  turns up in the log (`sentPutts`'s rule). Releasing it when the derivation
  REPORTS the answer looks equivalent and is not — an answer can land and never
  be reported back (a pick the engine then reads as stale), which strands the
  entry and makes that option permanently untappable. Same reason this channel
  does its own append instead of `emitOnce`, whose payload guard asks the weaker
  question and returns silently without writing, with no rollback behind it.
  Anything asking "is this hole still blocked?" filters on `!answered`, as
  `openActions` does on `!taken`.
  **A decision the screen STATES must be one its owner actually made.** Wolf's
  wolf can be reassigned by a score correction on a trailing-player hole, and a
  partner pick betrays that by naming the wrong player while a lone/blind
  declaration doesn't — so the pick records the wolf it was made under
  (`options[].data`) and a mismatch reads as stale. Latent while nothing showed
  the pick; a lie the moment something did.
- **A game that needs a PICTURE puts a token in the string, never a glyph**
  (`:wolf-shades:`, `engine/core/glyphs.ts`) — engines are pure TS and can't emit
  React. `GlyphText` swaps in 16×16 pixel art drawn in `public/icon.svg`'s idiom.
  ONLY `holeSummary` and `requiredInputs` decode it: the bar renders `summary`/
  `summaryParts` raw, and `settlement.lines`/`detailLines`/`notes` are painted
  onto a CANVAS for the share card, where a token becomes literal `:wolf:` inside
  a PNG people send each other. `glyphs.test.ts` walks every engine and fails on
  a token anywhere else. **Ship the word with the picture wherever the picture
  can't teach itself** — a 16px graphic can't say what "blind" costs, so the
  mode word rides along. Where the picture IS the fact and no word can carry it
  — the wolf mark on one name in "Ann 🐺 & Bob" — the glyph is `role="img"` with
  a label, and the small redundancy that creates on a button already reading
  "Lone Wolf" is the cheaper of the two errors.
- **Awards pull too — and they never expire.** `awards?(hole)`/`Award` is the
  THIRD channel (MAI-46), for "give THIS player THIS thing on THIS hole":
  closest to the pin, greenies, sandies, the snake. It renders as group rows ×
  player cells under the score rows (`AwardGrid`), every cell a toggle, and the
  engine decides which groups appear on which hole (CTP only on par 3s) so no
  screen learns any golf. **It deliberately does NOT inherit the actions
  affordance's `onFrontier && !allScored` gate**, and that is the whole ticket:
  a press belongs to the tee you are standing on, an award belongs to the hole
  it happened on — you remember it on 12, or fix it on the 18th green. Its one
  gate is `round/completed`, read off the EVENTS so a reopened round gets its
  grid back. `Award.data` MUST carry `hole`: `buildHoleLedger` places a game
  event in its prefix replay by reading it, and awards are the one thing
  designed to be recorded long after the hole they name. The tests worth keeping
  are the direct contrasts with the press tests in the same file. `GameAction`
  and `Award` share their write half (`GameEventOffer`) — they differ in WHEN
  they may be tapped, never in what a tap does.
- **An award is unclaimed exactly when it can no longer be claimed** — i.e. when
  `ctx.completed` says the round is over, the same instant the grid stops being
  tappable. Neither weaker test works, and both were tried: `ctx.finalized(hole)`
  goes true the moment play moves on, so an unawarded hole would report dead
  money while the group is two holes down the fairway intending to record it at
  the turn; and "every hole finalized" (the proxy Skins uses to kill its carry,
  which is right for Skins because a hole missing a score still settles among
  the scores posted) fires the moment one player picks up on the par 3, while
  the round is live and the cell is still lit. An award game also skips any hole
  `ctx.anyScored` says nobody played (MAI-38).
- **The share card is painted, not screenshotted.** `Share` on the settle screen
  produces a PNG drawn by hand onto a canvas (`paintSummaryCard.ts`), never a
  DOM capture — rasterising the live screen means `foreignObject`, and so means
  fighting Tailwind v4's `oklch()` colours, the woff2 files Vite leaves
  un-inlined, and iOS Safari, for a design that is rectangles and text.
  `buildSummaryCard` (`summaryCard.ts`) is the single derivation behind the
  settle screen AND the painter — both render that one model, so their numbers
  can't drift. (`ScorecardScreen` still derives its own grid. Its DEFAULT stroke
  game now agrees with the card's — both `src/lib/gameRoles.ts` — so only an
  explicit chip tap diverges; the image still names the game in its stroke note,
  because that tap is exactly what it can't know about.) The model
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
