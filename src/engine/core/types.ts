export type Uuid = string

export interface HoleCore {
  /** 1-based hole number on the course (1–18) */
  number: number
  par: number
  /** 18-hole stroke index: 1 = hardest */
  strokeIndex: number
  /**
   * Set only when a course is played more than once around — a nine twice, via
   * `doubleNine`. `hole` is the hole on the physical card this one replays and
   * `nth` is which time around, so the scorekeeper standing on the 5th tee for
   * the second time isn't asked for "hole 14" with no explanation. Absent on an
   * ordinary course, where `number` IS the hole. Display only: scoring, money
   * and the event log all key off `number`.
   */
  loop?: { hole: number; nth: number }
}

export interface TeeSet {
  id: Uuid
  name: string
  color?: string
  rating: number
  slope: number
  yardages?: number[]
  /** Per-hole stroke index for THIS tee (1 = hardest), when the card/API rates
   *  tees separately. Falls back to HoleCore.strokeIndex when absent. Length
   *  matches the course's holes; a valid 1..n permutation. */
  strokeIndexes?: number[]
  /** Per-hole par for THIS tee, when it differs by tee (e.g. a short hole that
   *  plays as a par 3 from a forward tee). Falls back to HoleCore.par. */
  pars?: number[]
}

export interface Course {
  id: Uuid
  name: string
  location?: string
  holeCount: 9 | 18
  holes: HoleCore[]
  teeSets: TeeSet[]
  source: 'seed' | 'user' | 'remote'
  /**
   * Who authored this card: an auth uid, or the guest sentinel while signed
   * out. Absent on API/seed imports and on legacy user cards. Ownership — not
   * provenance (`source`) — decides whether an edit updates in place or forks:
   * an imported copy of another golfer's course is `source:'user'` but still
   * theirs, and the server refuses updates to rows you didn't create (MAI-78).
   */
  createdBy?: string
  /**
   * The card this one was forked from (MAI-78): the original's id — for an
   * API import that is the provider's id, whose ODbL attribution must survive
   * into the shared library's `source_id` column when the fork publishes.
   * Absent on cards that aren't derived.
   */
  sourceId?: string
  updatedAt: string
  revision: number
}

export interface Player {
  id: Uuid
  name: string
  /** WHS handicap index — course handicap is computed per course/tee from this */
  handicapIndex?: number
  /** legacy fallback default from before indexes were stored */
  lastCourseHandicap?: number
  /** GHIN number, when the player was added via GHIN lookup (enables re-lookup) */
  ghinNumber?: string
  updatedAt: string
  /**
   * Owner partition. Signed-out ("guest") rows use the LOCAL_USER sentinel;
   * signing in claims them to the auth uid. Optional so the pure engine and
   * fixtures never have to declare it — repos always stamp it and the Dexie v2
   * upgrade backfills existing rows. See src/db/ids.ts (LOCAL_USER).
   */
  userId?: string
}

export interface RoundPlayer {
  playerId: Uuid
  /** snapshotted so a round stays self-contained */
  name: string
  /** what the player reported at setup; kept as a record, never re-derived */
  handicapIndex?: number
  /**
   * The number the engine actually uses; negative = plus handicap. It is the
   * course handicap for the course AS RATED — an 18-hole number on an 18-hole
   * course, a 9-hole number on a 9-hole course (`courseHandicapForTee`) — and
   * the engine scales it to the holes actually played. Authoritative: editing
   * it (first-tee adjustments) changes the strokes; the index does not.
   */
  courseHandicap: number
  teeSetId?: Uuid
}

/**
 * One row of a game's standings — a player (or a team key), what they are on,
 * and what it is worth.
 *
 * Lives here rather than in catalog.ts because `core/standings.ts` builds these
 * from a Settlement, and core is the bottom of the engine: it must not import
 * upward from the catalog. Re-exported by catalog.ts, where engines expect it.
 */
export interface StandingLine {
  /** playerId or team key */
  id: string
  label: string
  /** e.g. "3 skins" / "F 2↑ · B AS" */
  detail?: string
  amountCents: number
}

/**
 * The WRITE half the two optional channels share: offer something tappable,
 * emit exactly one game event, undo by retracting it (invariant #2 — compensate,
 * never delete).
 *
 * Deliberately NOT the lifecycle. WHEN a thing may be tapped is the entire
 * difference between an action and an award — a press belongs to the tee you
 * are standing on, an award belongs to whichever hole it happened on, forever —
 * and that difference lives on the screens, not here.
 *
 * Here rather than in catalog.ts for `StandingLine`'s reason: `core/awardPot.ts`
 * builds `Award`s, and core is the bottom of the engine. Re-exported by
 * catalog.ts, where engines expect it, alongside `GameAction` — which extends
 * this and stays up there, because nothing in core builds one.
 */
export interface GameEventOffer {
  /**
   * Stable id — the same offer across re-derives keeps the same id.
   *
   * Unique WITHIN this game, not across the round: an engine cannot see its
   * siblings, and a round can hold two instances of one game (MAI-44), so two
   * Nassaus both mint `nassau-press-front-3`. Any consumer flattening offers
   * from several games into one keyed list must compose with `gameId`.
   */
  id: string
  gameId: Uuid
  eventKind: string
  /**
   * Appended verbatim as the game event's data.
   *
   * IT MUST CARRY `hole`. `buildHoleLedger` places a game event in its
   * prefix replay by reading `data.hole` (ledger.ts), so a payload without one
   * is attributed to every prefix and lands its money on the wrong ledger row.
   * Awards make this load-bearing rather than incidental: they are the one
   * thing in the app designed to be recorded LONG after the hole they describe.
   */
  data: Record<string, unknown>
  /**
   * Already in effect. The offer stays visible rather than vanishing, so a
   * mistap is visible and reversible instead of silently final.
   */
  taken?: boolean
  /**
   * Events to retract to undo it (invariant #2: compensate, never delete).
   * Empty when the GAME started it rather than the player — an auto-press is
   * not theirs to undo, so the UI shows it engaged but inert.
   */
  undoEventIds?: Uuid[]
}

/**
 * ONE PLAYER, ONE THING, ONE HOLE — closest to the pin, a greenie, a sandie,
 * the snake. The third input channel, and it exists because neither of the
 * other two fits (MAI-46):
 *
 * - `requiredInputs` INTERRUPTS scoring: its hole cannot settle until someone
 *   answers, so it renders as a gold chip above the score rows. Nobody is stuck
 *   waiting on a greenie. (It has never DISABLED score entry — the screen has
 *   no such gate — so don't write code that assumes one.)
 * - `availableActions` is a flat list behind a button, and it is frontier-gated
 *   (`ScoringScreen`): correct for a press, which must be declared on the tee
 *   you are standing on, and wrong for an award in exactly the cases awards
 *   exist for. You remember on 12 that Rob had the greenie on 7; you mistap a
 *   KP and notice once every hole is scored. Both must stay recordable.
 *
 * THE LIFECYCLE RULE, which is the whole ticket: editable on ANY hole the round
 * has reached, including after every hole is scored, right up to
 * `round/completed`. Awards do not inherit the frontier gate.
 *
 * The engine decides which groups appear on which hole (KP only on par 3s), so
 * the grid stays generic and no screen ever grows per-game branching.
 */
export interface Award extends GameEventOffer {
  hole: number
  playerId: Uuid
  /** the row: what is being given, e.g. "Closest to the pin" */
  group: string
  /** the cell: who it would be given to, i.e. the player's name */
  label: string
  /** a cell is a toggle and is never indeterminate, so this is not optional */
  taken: boolean
}

export type HandicapMode = 'gross' | 'net'

/** Core-owned per-game handicap policy; engine config never re-declares this. */
export interface HandicapSettings {
  mode: HandicapMode
  /** percent of course handicap used, e.g. 100, 90 */
  allowancePct: number
  /** 'offLow' subtracts the lowest effective handicap from everyone */
  reference: 'absolute' | 'offLow'
}

export interface GameConfig<C = unknown> {
  /** instance id — two skins games could coexist in one round */
  gameId: Uuid
  type: string
  /**
   * Whether THIS round treats the game as its main event or a side bet.
   *
   * An EXPLICIT override, written only when a user chooses (MAI-44). Setup
   * writes nothing: whether an "either" game is this round's main event or its
   * side bet depends on what else is in the round, and freezing a guess into a
   * synced archive makes it permanently wrong.
   *
   * So ABSENT IS THE NORMAL CASE, and absent does NOT mean 'main' — it means
   * "derive it". Read it through `roleOf(game, round.games)` (catalog.ts),
   * never as `game.role ?? 'main'`, which would call a side bet running under a
   * Nassau the round's main event.
   *
   * PRESENTATION ONLY: `deriveRound` never reads it, so neither its absence nor
   * a junk value out of an imported file can change what anybody is owed.
   */
  role?: 'main' | 'side'
  handicap: HandicapSettings
  config: C
}

/**
 * HOW MANY holes, plus where the range starts by default. Which holes are
 * actually played is `holesForRound` (core/holes.ts) — this plus `startHole`.
 */
export type RoundHoles = 'front9' | 'back9' | 'full18'

export type RoundStatus = 'setup' | 'live' | 'completed'

export interface Round {
  id: Uuid
  courseId: Uuid
  /** frozen at tee-off: a played round replays identically forever */
  courseSnapshot: Course
  teeSetId: Uuid
  holes: RoundHoles
  players: RoundPlayer[]
  games: GameConfig[]
  status: RoundStatus
  startedAt: string
  updatedAt: string
  deviceId: string
  schemaVersion: number
  /**
   * Track putts on this round (MAI-90).
   *
   * The switch belongs to the ROUND rather than to a game's `meta`, because
   * putts are a scorecard fact: plenty of groups count them with no putting
   * game running, and Snake, Dots and Trouble all want the same number rather
   * than each collecting its own. Off means the scoring screen is unchanged —
   * a plain Skins round must not grow a putts row per player per hole.
   *
   * OPTIONAL, so it is additive: rounds stored before this shipped simply lack
   * it, sync carries the whole round as a blob, and `importRound` validates the
   * round with `z.looseObject`.
   *
   * A GAME CANNOT REQUIRE IT, and does not have to. `validateSetup` sees
   * config, players and siblings — never the round — so an engine reading putts
   * can never refuse a round with tracking off. The answer is the other way
   * round: the engine DECLARES the need (`meta.reads`), setup reads that
   * declaration and switches this on, and the group is told which game asked
   * rather than being offered a question they have no way to answer.
   *
   * NOTHING DECLARES IT TODAY. Snake was to be the first reader and moved to
   * the award channel instead (MAI-58) — the snake is a judgement about who
   * three-putted LAST, which a count cannot express — so this whole path is
   * dormant until Dots or Trouble, which want the count itself. One thing is
   * therefore still untested by any live game: a round that arrives holding a
   * fact-reading game WITHOUT this flag (an import, or a build predating the
   * game) renders no entry control, and that game derives nothing while looking
   * healthy. Whoever ships the first reader should close it — the scoring
   * screen ORing this with `roundReads` is the shape that works.
   */
  trackPutts?: boolean
  /**
   * The card hole this round teed off on, when it isn't the range's own first
   * (MAI-41). Absolute snapshot numbering, and the round WRAPS from there: 18
   * holes from 10 plays 10–18 and then 1–9, finishing on 9.
   *
   * OPTIONAL and stored only when it DIFFERS from the range default (1, or 10
   * for 'back9'), the `trackPutts` rule above: rounds written before this
   * shipped simply lack it, and a round that starts where its range already
   * says stays byte-identical. That is also what makes the change revertible —
   * see the note in `holesForRound`.
   *
   * Never read it to decide anything about ORDER. `ctx.holesPlayed` is the one
   * expression of which holes are played and in what sequence, and every engine
   * reads that instead.
   */
  startHole?: number
  /** Owner partition — see the note on Player.userId. */
  userId?: string
}
