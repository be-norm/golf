import type { z } from 'zod'
import type { GameScopedEvent, RoundEvent } from './core/events'
import { buildRoundContext, type RoundContext } from './core/context'
import { effectiveEvents, gameEventsFor } from './core/replay'
import type { Settlement } from './core/money'
import type {
  GameConfig,
  HandicapSettings,
  Round,
  RoundPlayer,
  StandingLine,
  Uuid,
} from './core/types'

// Defined in core/types.ts (core/standings.ts builds them, and core cannot
// import upward from the catalog), re-exported here because engines reach for
// it alongside GameDerivation.
export type { StandingLine }

/** A blocking prompt the scoring UI renders as a generic chip — no game-specific screens. */
export interface InputRequest {
  /** stable id so answering emits exactly one event */
  id: string
  gameId: Uuid
  hole: number
  prompt: string
  options: { value: string; label: string }[]
  /** the game event kind to append with data { hole, choice } */
  eventKind: string
}

/**
 * A player-initiated optional action (Nassau press today; hammer / Banker
 * wagers are the same shape). PULL, NOT PUSH — the UI parks these behind a
 * button instead of interrupting scoring, because availability ("this is
 * legal now") is true on most holes and would nag if it interrupted.
 *
 * `recommended` is the separate, occasional claim — "the game's convention
 * says take this NOW" — and is the only thing the UI badges. Keeping the two
 * apart is the whole point of this channel: a game that conflates them ends up
 * interrupting on every hole (see MAI-34).
 *
 * Contrast `InputRequest`, which is genuinely blocking: Wolf's hole cannot
 * compute without its pick, so that one is right to interrupt.
 */
export interface GameAction {
  /** stable id — same action across re-derives keeps the same id */
  id: string
  gameId: Uuid
  /** the hole the action takes effect from (a press starts here) */
  hole: number
  /** the button, e.g. "Press F9" */
  label: string
  /** WHY it is offered, e.g. "Rob 2 down · 5 to play" */
  detail: string
  /** what taking it creates, e.g. "New $5 bet · holes 5–9" */
  effect: string
  /** the game's convention says act now — the UI badges these */
  recommended: boolean
  eventKind: string
  /** appended verbatim as the game event's data */
  data: Record<string, unknown>
  /**
   * Already in effect. The row stays in the list rather than vanishing, so a
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

export interface GameDerivation {
  standings: StandingLine[]
  /** one-liner for the pinned mini-bar, e.g. "Ben +$3 · 2 carried" */
  summary: string
  /**
   * Structured form of the summary for the pinned bar (UIs style it):
   * label = small gold chip (e.g. "H4"), value = the status.
   *
   * CONVENTION every new game follows: the bar recaps the LATEST DECIDED HOLE
   * — what just happened — via `latestHoleSummary` in core/summary.ts. Never
   * the running aggregate (that lives in the standings sheet). Match-play games
   * (Nassau) are the documented exception: their bar shows live bet status.
   */
  summaryParts?: { label: string; value: string }[]
  /**
   * Optional per-bet/per-item status ledger for the standings sheet —
   * one line per live or settled bet (e.g. every nassau bet incl. presses,
   * "F9 · Ben ↑2 · dormie"). depth indents children under their parent.
   */
  detailLines?: { label: string; value: string; depth?: number }[]
  /**
   * Per-hole narration for the money ledger and standings sheet. CONVENTION:
   * state the outcome, THEN explain the CAUSE of anything non-obvious on a
   * "↳ " continuation line — the birdie behind a Vegas flip, the carry behind
   * a multi-skin win, the 2-down behind a Nassau press, the lone/blind behind
   * Wolf's points. A reader should never have to ask "why did that happen?".
   */
  holeSummary(hole: number): string[]
  requiredInputs(): InputRequest[]
  /**
   * Optional player-initiated actions, surfaced behind a button rather than
   * interrupting play. Implement it and the scoring screen grows a PRESS-style
   * affordance for this game; leave it off and nothing changes.
   */
  availableActions?(): GameAction[]
  settlement: Settlement
  /**
   * Things the game has to SAY on the settle surface that are not money
   * movements — "3 skins died unwon", say. Rendered as annotation, below the
   * money and visibly apart from it.
   *
   * This channel exists so narration never has to be smuggled into
   * `settlement.lines`. That field is the record of money that MOVED; a
   * zero-cent row in it makes `lines.length === 0` — the model's "No money
   * moved." signal — false for a round where no money moved, and hands every
   * future consumer a phantom entry to special-case (MAI-40). Same reasoning
   * as `GamePanel.kind`: carry the intent, don't overload a field and let a
   * renderer infer it.
   *
   * For per-hole narration use `holeSummary`; this is for what's true of the
   * round as a whole, once.
   */
  notes?: string[]
}

/**
 * Declarative config form fields — the setup wizard renders these generically,
 * so no game ever ships custom setup UI. 'teams' and 'rotation' are the
 * first-class participant-assignment field types (Vegas teams, Wolf order).
 */
export type ConfigFieldSpec =
  | { key: string; kind: 'money'; label: string; hint?: string }
  | { key: string; kind: 'boolean'; label: string; hint?: string }
  | { key: string; kind: 'select'; label: string; options: { value: string; label: string }[] }
  | { key: string; kind: 'teams'; label: string }
  | { key: string; kind: 'rotation'; label: string }

/**
 * Whether a game can be the round's main event, a side bet alongside one, or
 * either. ELIGIBILITY AND DEFAULT — not the per-round truth, which is
 * `GameConfig.role`: Skins is routinely the main game AND routinely a side bet
 * next to a Nassau, and only the round knows which it is this time.
 */
export type GameCategory = 'main' | 'side' | 'either'

/**
 * THE role of a game in a round. Every display rule is to read it through
 * here rather than re-deriving the default — MAI-44's picker and density rules
 * are the first consumers; today only its tests call it.
 *
 * It takes the whole round because 'either' CANNOT be answered from the engine
 * alone. Skins beside a Nassau is the side bet; Skins on its own is the main
 * event — the same engine, the same config, a different answer, which is
 * precisely what invariant #7 means by "only the round knows". A per-game
 * default blind to that would call both games in a Skins+Nassau round the main
 * event.
 *
 * Which is also why setup does not STAMP this. `role` is presentation-only, so
 * a round that stores nothing can be re-read by a better rule later; a round
 * that stored a guess is wrong permanently, in an archive that syncs. Only an
 * explicit user choice gets written (MAI-44), and only that short-circuits here.
 */
export function roleOf(game: GameConfig, allGames: readonly GameConfig[]): 'main' | 'side' {
  // An explicit choice wins — but only if it is one of the two things it can
  // be. `role` arrives from imported JSON that validates games loosely
  // (exportRound.ts), so an unvalidated value would be handed back typed as the
  // union while being neither, and the first `=== 'side'` check would silently
  // treat it as a main event.
  if (game.role === 'main' || game.role === 'side') return game.role

  // ONE default for an unknown type, used for this game AND for its siblings
  // below. Reading it as 'main' here but as "claims nothing" there made an
  // imported round holding a game this build doesn't ship report two main
  // events — the mirror of the bug the explicit-role branch above fixes.
  const categoryOf = (g: GameConfig) => getEngine(g.type)?.meta.category ?? 'main'
  const category = categoryOf(game)
  if (category !== 'either') return category
  // An "either" game is the side bet when something else claims the main event,
  // and the main event when nothing does. "Claims" reads a sibling's EXPLICIT
  // role first: a user who demotes their Nassau to a side bet has said this
  // round has no main game, and ignoring that would leave the round with two
  // side bets and no main event — while a user promoting one of two Skins has
  // said the other is the side bet. Non-recursive by construction: a sibling
  // without an explicit role answers from its category alone.
  const claimsMain = (g: GameConfig) =>
    g.role === 'main' || g.role === 'side'
      ? g.role === 'main'
      : categoryOf(g) === 'main'
  if (allGames.some((g) => g.gameId !== game.gameId && claimsMain(g))) return 'side'

  // Nobody claims it. Two "either" games — gross skins and net skins, the very
  // round `gameLabel` exists for — would otherwise BOTH read 'main', which is
  // the two-main-events bug in a different disguise. The first one in the round
  // takes the main event; a group reads their own card top-down.
  const firstUnclaimed = allGames.find(
    (g) => !(g.role === 'main' || g.role === 'side') && categoryOf(g) === 'either',
  )
  return firstUnclaimed === undefined || firstUnclaimed.gameId === game.gameId ? 'main' : 'side'
}

/**
 * HOW THE BET IS DECIDED — the picker sheet's default grouping.
 *
 * One axis, chosen deliberately over the two alternatives (MAI-43):
 *
 * - "Who plays whom" (solo/teams/partners) reads better in a picker, but it
 *   CANNOT live on `meta`: Nassau is 1v1 or 2v2 by its `teams` config, and Best
 *   Ball will be the same. An axis that can't file the most-played game in the
 *   catalog without reading its config isn't a property of the engine. It
 *   survives as `shapes` below, as a SET rather than a single value.
 * - "How scores are entered" (strokes / team gross / extra inputs) is what
 *   docs/games-catalog.md tags games with and it predicts build cost well, but
 *   it barely divides them: against 3 team-gross formats and 9 with extra
 *   inputs, everything else is strokes-only. One bucket holding two thirds of
 *   the catalog is not a grouping. It stays in the doc, where it belongs.
 *
 * What is left is how the money gets decided, which is also the vocabulary
 * golfers actually use ("let's play a match" / "skins" / "Stableford").
 */
export type GameFamily =
  /** holes won, lost or halved against a side; decided when a side is up more than remains */
  | 'match'
  /** total strokes decide it */
  | 'stroke'
  /** points accumulate and settle on the spread between players */
  | 'points'
  /** a prize per hole, won outright or carried forward */
  | 'pot'
  /** discrete achievements, tallied */
  | 'award'
  /** a bet offered and accepted mid-hole, escalating its value */
  | 'wager'

/**
 * The social shapes a game SUPPORTS — a set, not a single value, which is what
 * lets it stay on `meta` where `family`'s rejected team axis could not: Nassau
 * genuinely is both `headToHead` and `teams`, and says so.
 *
 * Powers the picker's alternate "what team games can we play?" view. Because
 * the roster is already chosen by the time the picker opens, that view can
 * intersect these with the player count — showing Nassau's 2v1 at three players
 * while hiding Vegas, which needs four.
 */
export type GameShape =
  /** every player for themselves */
  | 'solo'
  /** one against one */
  | 'headToHead'
  /** fixed sides for the whole round */
  | 'teams'
  /** sides that re-form each hole */
  | 'partners'

/** Player-facing rules, rendered generically by the rules sheet. Must describe
 *  THIS implementation (our point tables, our press conventions), not folklore. */
export interface GameRules {
  tagline: string
  howToPlay: string[]
  scoring: string[]
  terms: { term: string; def: string }[]
}

export interface GameEngine<C = unknown> {
  type: string
  meta: {
    name: string
    blurb: string
    minPlayers: number
    maxPlayers: number
    /**
     * PRESENTATION ONLY, all three of these. They drive setup grouping, the
     * picker sheet and display density — `deriveRound` never reads them, and
     * neither does any engine's `derive`. A game's money is a pure function of
     * (config, its own events, RoundContext); taxonomy is how the app talks
     * about games, not how they compute.
     */
    category: GameCategory
    family: GameFamily
    /** every shape this game can be played in; see GameShape */
    shapes: readonly GameShape[]
    rules: GameRules
  }
  configSchema: z.ZodType<C>
  configFields: ConfigFieldSpec[]
  defaultConfig(players: readonly RoundPlayer[]): C
  defaultHandicap(): HandicapSettings
  /** [] = valid; otherwise human-readable problems shown in setup */
  validateSetup(config: GameConfig<C>, players: readonly RoundPlayer[]): string[]
  /** zod schema per game/event kind this engine understands */
  eventKinds: Record<string, z.ZodType>
  /** Pure derivation from config + this game's events + the shared context. */
  derive(config: GameConfig<C>, events: readonly GameScopedEvent[], ctx: RoundContext): GameDerivation
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, GameEngine<any>>()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerEngine(engine: GameEngine<any>): void {
  registry.set(engine.type, engine)
}

export function getEngine(type: string): GameEngine | undefined {
  return registry.get(type)
}

export function listEngines(): GameEngine[] {
  return [...registry.values()]
}

/** Replay a round: retraction pass → shared context → per-game derivations. */
export function deriveRound(
  round: Round,
  events: readonly RoundEvent[],
): { ctx: RoundContext; derivations: Map<Uuid, GameDerivation> } {
  const effective = effectiveEvents(events)
  const ctx = buildRoundContext(round, effective)
  const derivations = new Map<Uuid, GameDerivation>()
  for (const game of round.games) {
    const engine = registry.get(game.type)
    if (!engine) continue
    // Same rule as the event schemas below, applied one level up: a config the
    // engine itself rejects makes the game INERT rather than letting it settle.
    // Skins handed `{}` destructures `stakeCents` to undefined and pays
    // `skins * undefined` — NaN in every settlement line, NaN through
    // minimalTransfers, and zero-sum quietly false. A game that cannot be
    // scored must move no money at all.
    if (!engine.configSchema.safeParse(game.config).success) continue
    // Enforce each engine's event schemas here, once: an unknown kind or a
    // malformed payload (corrupt import, stale event) is dropped rather than
    // blind-cast inside the engine — reducers stay total, bad data is inert.
    const gameEvents = gameEventsFor(effective, game.gameId).filter((e) => {
      const schema = engine.eventKinds[e.kind]
      return schema !== undefined && schema.safeParse(e.data).success
    })
    derivations.set(game.gameId, engine.derive(game, gameEvents, ctx))
  }
  return { ctx, derivations }
}
