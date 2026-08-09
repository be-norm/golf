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
 * It DOES need a clearer, unlike `score/set` — which is why one exists here and
 * no screen has ever emitted `score/clear`. For a stroke, "wrong number" is
 * fixed by writing the right number; there is no meaningful blank. For putts
 * there is, because 0 is a real count: without a way back to "not recorded" the
 * only erase gesture available is to enter 0, which does not mean "I never
 * saw this" — it means "chip-in", and Dots pays for one.
 */
export type ScorePuttsEvent = EventEnvelope & {
  type: 'score/putts'
  playerId: Uuid
  hole: number
  putts: number
}

/** Take back a putt count entirely, to "not recorded" — NOT to zero. */
export type ScorePuttsClearEvent = EventEnvelope & {
  type: 'score/puttsClear'
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
  | ScorePuttsEvent
  | ScorePuttsClearEvent
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
  z.object({
    type: z.literal('score/puttsClear'),
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
