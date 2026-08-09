import { z } from 'zod'
import type { Uuid } from './types'

export interface EventEnvelope {
  id: Uuid
  roundId: Uuid
  /** per-round monotonically increasing sequence — the ordering authority */
  seq: number
  at: string
  deviceId: string
}

export type ScoreSetEvent = EventEnvelope & {
  type: 'score/set'
  playerId: Uuid
  hole: number
  gross: number
}

export type ScoreClearEvent = EventEnvelope & {
  type: 'score/clear'
  playerId: Uuid
  hole: number
}

/**
 * How many putts a player took on a hole — a SCORECARD fact, sitting beside the
 * stroke rather than inside any bet (MAI-54, MAI-90).
 *
 * It is round-level because it is true regardless of which games are running:
 * golfers write putts on the paper card whether or not anyone is betting on
 * them, and Snake, Dots and Trouble all need the same number. Each engine
 * collecting its own would mean entering it twice for one hole and letting two
 * games disagree about what happened.
 *
 * ZERO IS A REAL VALUE — a chip-in takes no putts — and it is not the same as
 * "not recorded", so absence must never be folded to 0. `RoundContext` keeps
 * the two apart.
 *
 * No `score/puttsClear` counterpart, deliberately and by precedent: nothing in
 * the app emits `score/clear` either. The setter ships and the clearer arrives
 * when a screen actually needs one; undo is `meta/retract`, as everywhere else.
 */
export type ScorePuttsEvent = EventEnvelope & {
  type: 'score/putts'
  playerId: Uuid
  hole: number
  putts: number
}

export type RoundCompletedEvent = EventEnvelope & { type: 'round/completed' }
export type RoundReopenedEvent = EventEnvelope & { type: 'round/reopened' }

/** Uniform undo: never delete events, always compensate. Retracts cannot target retracts. */
export type RetractEvent = EventEnvelope & { type: 'meta/retract'; targetEventId: Uuid }

/** Game-scoped event, routed by gameId; payload validated by that engine's eventKinds schema. */
export type GameScopedEvent = EventEnvelope & {
  type: 'game/event'
  gameId: Uuid
  kind: string
  data: unknown
}

export type RoundEvent =
  | ScoreSetEvent
  | ScoreClearEvent
  | ScorePuttsEvent
  | RoundCompletedEvent
  | RoundReopenedEvent
  | RetractEvent
  | GameScopedEvent

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Event payload without its envelope — what callers hand to EventStore.append. */
export type EventDraft = DistributiveOmit<RoundEvent, keyof EventEnvelope>

export const eventDraftSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('score/set'),
    playerId: z.string(),
    hole: z.number().int().min(1).max(18),
    gross: z.number().int().min(1).max(30),
  }),
  z.object({
    type: z.literal('score/clear'),
    playerId: z.string(),
    hole: z.number().int().min(1).max(18),
  }),
  z.object({
    type: z.literal('score/putts'),
    playerId: z.string(),
    hole: z.number().int().min(1).max(18),
    // 0 is a chip-in, not "unrecorded"; 10 matches `gross`'s upper bound in
    // spirit — a number past it is a mistap, and the log is forever.
    putts: z.number().int().min(0).max(10),
  }),
  z.object({ type: z.literal('round/completed') }),
  z.object({ type: z.literal('round/reopened') }),
  z.object({ type: z.literal('meta/retract'), targetEventId: z.string() }),
  z.object({
    type: z.literal('game/event'),
    gameId: z.string(),
    kind: z.string(),
    data: z.unknown(),
  }),
])
