import type { z } from 'zod'
import type { GameScopedEvent, RoundEvent } from './core/events'
import { buildRoundContext, type RoundContext } from './core/context'
import { effectiveEvents, gameEventsFor } from './core/replay'
import type { Settlement } from './core/money'
import type { GameConfig, HandicapSettings, Round, RoundPlayer, Uuid } from './core/types'

export interface StandingLine {
  /** playerId or team key */
  id: string
  label: string
  /** e.g. "3 skins" / "F 2↑ · B AS" */
  detail?: string
  amountCents: number
}

/** A blocking prompt the scoring UI renders as a generic chip — no game-specific screens. */
export interface InputRequest {
  /** stable id so answering emits exactly one event */
  id: string
  gameId: Uuid
  hole: number
  prompt: string
  /** optional inputs render as chips but never block play (e.g. press offers) */
  optional?: boolean
  options: { value: string; label: string }[]
  /** the game event kind to append with data { hole, choice } */
  eventKind: string
}

export interface GameDerivation {
  standings: StandingLine[]
  /** one-liner for the pinned mini-bar, e.g. "Ben +$3 · 2 carried" */
  summary: string
  /**
   * Optional structured form of the summary for UIs that can style it:
   * label = small metadata chip (e.g. "F9"), value = the status itself.
   * Falls back to `summary` when absent.
   */
  summaryParts?: { label: string; value: string }[]
  /**
   * Optional per-bet/per-item status ledger for the standings sheet —
   * one line per live or settled bet (e.g. every nassau bet incl. presses,
   * "F9 · Ben ↑2 · dormie"). depth indents children under their parent.
   */
  detailLines?: { label: string; value: string; depth?: number }[]
  holeSummary(hole: number): string[]
  requiredInputs(): InputRequest[]
  settlement: Settlement
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
