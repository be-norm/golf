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
  options: { value: string; label: string }[]
  /** the game event kind to append with data { hole, choice } */
  eventKind: string
}

export interface GameDerivation {
  standings: StandingLine[]
  /** one-liner for the pinned mini-bar, e.g. "Ben +$3 · 2 carried" */
  summary: string
  holeSummary(hole: number): string[]
  requiredInputs(): InputRequest[]
  settlement: Settlement
}

export interface GameEngine<C = unknown> {
  type: string
  meta: {
    name: string
    blurb: string
    minPlayers: number
    maxPlayers: number
  }
  configSchema: z.ZodType<C>
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
    derivations.set(game.gameId, engine.derive(game, gameEventsFor(effective, game.gameId), ctx))
  }
  return { ctx, derivations }
}
