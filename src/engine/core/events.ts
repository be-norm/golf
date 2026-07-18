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
