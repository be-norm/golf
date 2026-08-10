import type { z } from 'zod'
import type { GameScopedEvent, RoundEvent } from './core/events'
import { buildRoundContext, type RoundContext } from './core/context'
import { effectiveEvents, gameEventsFor } from './core/replay'
import type { Settlement } from './core/money'
import type {
  Award,
  GameConfig,
  GameEventOffer,
  HandicapSettings,
  Round,
  RoundPlayer,
  StandingLine,
  Uuid,
} from './core/types'

// Defined in core/types.ts (core builds all three — `core/standings.ts` the
// standings, `core/awardPot.ts` the offers and awards — and core cannot import
// upward from the catalog), re-exported here because engines reach for them
// alongside GameDerivation.
export type { StandingLine, GameEventOffer, Award }

/** A blocking prompt the scoring UI renders as a generic chip — no game-specific screens. */
export interface InputRequest {
  /** stable id so answering emits exactly one event */
  id: string
  gameId: Uuid
  hole: number
  prompt: string
  /**
   * `data` rides along into the emitted payload, under the channel's own
   * `{ hole, choice }` — so an option can carry the extra facts its answer
   * needs (which of Bingo Bango Bongo's three points, a hammer's multiplier)
   * without every such game inventing a second event kind. It cannot overwrite
   * `hole` or `choice`: those are the channel's contract, and an option that
   * disagreed with the prompt it was rendered under would be a bug, not a
   * feature.
   */
  options: { value: string; label: string; data?: Record<string, unknown> }[]
  /** the game event kind to append with data { ...option.data, hole, choice } */
  eventKind: string
  /**
   * ALREADY ANSWERED. The request STAYS IN THE LIST rather than vanishing, so
   * the decision it recorded is visible and changeable instead of silently
   * final — Wolf's teams used to disappear the instant they were picked, and a
   * mistapped partner was then only reachable while it was still the round's
   * last event.
   *
   * Same doctrine as `GameEventOffer.taken`, and the same shape of consumer:
   * anything asking "is this hole still blocked?" filters on `!answered`,
   * exactly as `ScoringScreen` counts what is left to take with
   * `actions.filter((a) => !a.taken)`. WHICH MEANS THE LIST'S LENGTH IS NOT A
   * COUNT OF BLOCKERS and never falls to zero on a fully-declared round — a
   * gate that counts it gets a round that can never look settled. `wolf.test.ts`
   * fails on that rather than leaving it to this paragraph.
   *
   * `value` is the option in effect, so the picker can mark it engaged.
   * `lines` is how the GAME states the resolved position — stacked verbatim,
   * with the screen owning none of the vocabulary.
   *
   * NO `undoEventIds`: an answer is REPLACED, not retracted. Every input
   * reducer is last-write-wins per hole, so re-answering is one more event of
   * the same kind and the newest one counts.
   */
  answered?: { value: string; lines: string[] }
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
export interface GameAction extends GameEventOffer {
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
  /**
   * The badge on a recommended row, in the game's own words — "2 down" for a
   * Nassau press. Short: it renders in a 9px column beside the row.
   *
   * NOT `detail`, which the row already prints two lines up. Sourcing the badge
   * from there would set "Bob 2 down · 7 to play" twice in one row and blow the
   * column. This is per-action rather than per-engine because the reason can
   * vary between offers even though Nassau's happens not to (MAI-47).
   */
  recommendedReason?: string
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
  /**
   * Per-player, per-hole awards for ONE hole — the grid under the score rows.
   * Implement it and the scoring screen grows an award grid for this game;
   * leave it off and nothing changes.
   *
   * Takes the hole, like `holeSummary`, rather than returning the round's worth
   * at once: 18 holes × 4 players × 6 groups is 432 objects per game per
   * derive, and `deriveRound` runs on every tap plus once per hole inside
   * `buildHoleLedger`'s prefix replay.
   */
  awards?(hole: number): Award[]
  settlement: Settlement
  /**
   * Things the game has to SAY that are not money movements — "3 skins died
   * unwon", say. Rendered as annotation, below the money and visibly apart
   * from it.
   *
   * THREE SURFACES, and not all of them are the end of the round: the settle
   * screen, the standings sheet mid-round, and the first-tee screen
   * (`RoundStartScreen`). Most notes gate themselves on `ctx.completed`,
   * because dead money is only dead once it can no longer be won — but that is
   * each game's judgement, not this channel's rule. A note that is STRUCTURAL
   * (Long Drive on a card with no par 5 can never pay anything) is true from
   * the first tee and must not wait for the settle screen to be read out,
   * which is the one moment the group can no longer act on it.
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
  /**
   * `min`/`max`/`step` are per-field because one range cannot serve every
   * money field: a Nassau unit moves in dollars, a Vegas point in nickels, and
   * the setup card used to hardcode 25–10000¢ with an implicit 1¢ step for all
   * of them — which put 400 taps between $1 and $5 (MAI-44). Optional, so a
   * field that doesn't care keeps the sane defaults.
   */
  | { key: string; kind: 'money'; label: string; hint?: string; min?: number; max?: number; step?: number }
  | { key: string; kind: 'boolean'; label: string; hint?: string }
  | { key: string; kind: 'select'; label: string; options: { value: string; label: string }[] }
  | { key: string; kind: 'teams'; label: string }
  | { key: string; kind: 'rotation'; label: string }
  /**
   * WHICH HOLES a bet runs on — a named rule, or a list the group picked at the
   * tee. The value is a preset's `value` (a string) OR an explicit `number[]`.
   *
   * ONE FIELD RATHER THAN A SELECT PLUS A CONDITIONAL LIST, because
   * `ConfigFieldSpec` has no conditional-visibility mechanism and adding one
   * (`showWhen`) is the bigger change: every renderer of these specs would have
   * to honour it, and one that didn't would silently draw a dead control. One
   * key, one value keeps the spec declarative.
   *
   * THE PRESETS ARE THE ENGINE'S, so golf semantics never land inside a field
   * kind — "par 5s" is Long Drive's rule, not this control's, and Rabbit's
   * "9 and 18" will be its own. The editor only knows "a named rule, or these
   * numbers", which is why the next game to want holes needs no UI work.
   *
   * The offered numbers are THE ROUND'S, in play order (`holesForRound`), so a
   * round teeing off on 10 offers 10…18, 1…9 — position is what sequences a
   * round, not the number painted on the marker (invariant #9).
   */
  | {
      key: string
      kind: 'holes'
      label: string
      hint?: string
      /** named alternatives to an explicit list, in the engine's own words */
      presets: { value: string; label: string }[]
      /** the chip that reveals the grid, e.g. "Pick them" */
      customLabel: string
    }

/**
 * Whether a game can be the round's main event, a side bet alongside one, or
 * either. ELIGIBILITY AND DEFAULT — not the per-round truth, which is
 * `GameConfig.role`: Skins is routinely the main game AND routinely a side bet
 * next to a Nassau, and only the round knows which it is this time.
 */
export type GameCategory = 'main' | 'side' | 'either'

/**
 * THE role of a game in a round. Every display rule is to read it through
 * here rather than re-deriving the default. Its consumers are
 * `src/lib/gameRoles.ts` (the one primary-game rule, and the main/side split
 * behind the pinned bar's collapse and the share card's grouping) and setup,
 * which uses it to decide what — if anything — to store.
 *
 * It takes the whole round because 'either' CANNOT be answered from the engine
 * alone. Skins beside a Nassau is the side bet; Skins on its own is the main
 * event — the same engine, the same config, a different answer, which is
 * precisely what invariant #7 means by "only the round knows". A per-game
 * default blind to that would call both games in a Skins+Nassau round the main
 * event.
 *
 * Which is also why setup stamps this as RARELY as it can. `role` is
 * presentation-only, so a round that stores nothing can be re-read by a better
 * rule later, while a round that stored a guess is wrong permanently in an
 * archive that syncs. Setup writes one only where the section the user picked
 * into contradicts what this function derives, and only in a round holding more
 * than one game — below that nothing reads the difference at all. See
 * `reconcileRoles` (SetupScreen.tsx).
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

/**
 * How this game TALKS about its optional actions — the button, the sheet
 * header, the explainer, the empty state.
 *
 * A sibling of `meta.rules` because it is the same kind of thing: player-facing
 * copy the engine owns. `GameAction` is a generic channel, but every string
 * around it used to be Nassau's, so the second action-bearing game would have
 * inherited "Press" as its button and "a press is a new bet at the same stake"
 * as its explanation (MAI-47).
 *
 * `plural` is declared rather than derived: "Press" + "s" is "Presss".
 */
export interface GameActionCopy {
  /** the button and the sheet header — "Press" | "Throw" | "Wager" */
  verb: string
  /** the header when nothing names a hole — "Presses" */
  plural: string
  /** what taking one of these MEANS, in a sentence or two */
  blurb: string
  /** why there is nothing on offer, stated as the RULE rather than one cause */
  emptyState: string
}

/**
 * A fact about how a hole was PLAYED that lives on the round rather than in any
 * one bet, is entered by the scorekeeper, and reaches engines through
 * `RoundContext` — the one-way escape hatch invariant #7 reserves.
 *
 * A set rather than a boolean per fact because the hatch is designed to carry
 * more of them: Criers & Whiners' mulligan credits are the next one the catalog
 * names. Each is something several games want and none should collect twice.
 */
export type RoundFact = 'putts'

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
    /**
     * STROKES DO NOT DECIDE THIS GAME, so a handicap policy is meaningless for
     * it — closest to the pin, long drive, the snake. One shot or one putt is
     * measured against the other players' shots, not against anybody's index.
     *
     * Setup hides the handicap control entirely rather than offering a choice
     * that changes nothing, which is the visible half. The half that matters is
     * `strokeGame` (`src/lib/gameRoles.ts`): a net game can capture the
     * scorecard's stroke dots and the share card's "underline = handicap
     * stroke: X" note, and in a round of nothing but side bets `primaryGame`
     * falls through to `games[0]` — so a CTP flipped to net, or arriving net
     * from an import, would label underlines it never earned.
     *
     * PRESENTATION, like the rest of `meta`: `deriveRound` never reads it, and
     * these engines never ask `ctx` for a stroke either way. It says what is
     * true, it does not enforce it — `catalog.test.ts` checks the engine's own
     * `defaultHandicap` agrees, so the declaration cannot quietly contradict
     * the game it describes.
     */
    grossOnly?: boolean
    rules: GameRules
    /**
     * Round-level facts this engine READS out of `RoundContext` — the ones a
     * scorekeeper has to enter and no engine can derive alone (MAI-90).
     *
     * Presentation, like everything else on `meta`: `deriveRound` never looks
     * at it. What reads it is SETUP, which turns the round's collection of that
     * fact on and says which game asked. That is the only way a game can
     * require one — `validateSetup` sees config, players and siblings, never
     * the round, so an engine cannot otherwise refuse a round that isn't
     * collecting what it needs, and would derive nothing while looking healthy.
     *
     * It is also what keeps the entry affordance off every other round: a group
     * playing Skins is asked for putts by nobody, so nothing asks them.
     */
    reads?: readonly RoundFact[]
    /**
     * Required of any engine whose `derive` returns `availableActions` — the
     * shared affordance has no vocabulary of its own, and a game that offers
     * actions without declaring this would render the previous game's verb.
     * Enforced by catalog.test.ts rather than by the type, which cannot see
     * inside `derive`.
     */
    actions?: GameActionCopy
  }
  configSchema: z.ZodType<C>
  configFields: ConfigFieldSpec[]
  defaultConfig(players: readonly RoundPlayer[]): C
  defaultHandicap(): HandicapSettings
  /**
   * [] = valid; otherwise human-readable problems shown in setup.
   *
   * `siblings` is THE OTHER GAMES IN THE ROUND, this one excluded — setup can
   * hold two instances of the same game (MAI-44), so "you've added Skins twice
   * with identical settings" is only answerable with the round in view.
   *
   * It stays a validation channel, not a coupling: an engine may compare its
   * own type's settings, but reading another engine — its meta, its derive —
   * is invariant #7's one-way rule and is banned by lint. Nothing here reaches
   * `derive`, so no sibling can ever move money.
   */
  validateSetup(
    config: GameConfig<C>,
    players: readonly RoundPlayer[],
    siblings: readonly GameConfig[],
  ): string[]
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
