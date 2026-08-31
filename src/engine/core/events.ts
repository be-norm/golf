import { z } from 'zod'
import type { HandicapSettings, Uuid } from './types'

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

/**
 * ONE GAME'S SETTINGS, CHANGED FOR THE WHOLE ROUND (MAI-100/101).
 *
 * A stake set wrong, a carryover nobody switched on, a doubling pot the group
 * meant to play — noticed on the ninth green, with eight holes already scored.
 * Before this the only remedy was to abandon the round, because settings live on
 * the round DOCUMENT (`round.games[].config`), outside the log, and `deriveRound`
 * reads them wholesale: changing one rewrote every settled hole's money silently,
 * which is what invariant #2 exists to prevent.
 *
 * So the change becomes an event, and gets everything the log already gives:
 * undo is `meta/retract`, sync and export carry it (archives are a
 * `{round, events}` blob), and the round says what happened to it rather than
 * quietly disagreeing with the numbers people remember.
 *
 * IT RE-PRICES THE WHOLE ROUND — "it was always $2" — and that is the only
 * reading the engine contract can express: `derive` takes ONE config, so
 * "from here on" would mean rewriting all nine engines, and it has no defined
 * answer anyway (a skin carried at $1 and banked at $2 is worth what?). The
 * editor states it in as many words, and shows the money swing before you commit.
 *
 * THE WHOLE CONFIG, NOT A PATCH. A partial payload would need merge rules per
 * key, and a merge that dropped one would leave a config its own engine rejects
 * — which `deriveRound` makes INERT, i.e. a mistyped stake silently deleting a
 * live bet. `amendRound` refuses an amendment the engine won't accept for the
 * same reason (catalog.ts).
 *
 * `role` is absent in the normal case, and absent means DERIVE IT rather than
 * 'main' — `GameConfig.role`'s own rule. Since this replaces wholesale, an
 * amendment that omits it clears a stamp the round was carrying, which is
 * correct: the editor re-runs `reconcileRoles` and sends what that decides.
 */
export type GameConfiguredEvent = EventEnvelope & {
  type: 'game/configured'
  gameId: Uuid
  config: unknown
  handicap: HandicapSettings
  role?: 'main' | 'side'
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
  | GameConfiguredEvent
  | RoundCompletedEvent
  | RoundReopenedEvent
  | RetractEvent
  | GameScopedEvent

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Event payload without its envelope — what callers hand to EventStore.append. */
export type EventDraft = DistributiveOmit<RoundEvent, keyof EventEnvelope>

/**
 * A game's handicap policy, as it travels in an amendment payload.
 *
 * BOUNDED, and the allowance is the reason: it reaches `applyAllowance`, so an
 * unbounded number produces negative playing handicaps for every hole of the
 * round — wrong money that looks like arithmetic rather than corruption. The
 * same 0–200 window `importSchema` repairs an imported game into
 * (exportRound.ts), stated once here now that a second path carries one.
 *
 * Strict where `importSchema` is forgiving, and deliberately: an import is a
 * RESTORE of a file we did not write, so it repairs what it can; this is a
 * write THIS app is making right now, and a payload it cannot form correctly is
 * a bug to surface rather than round off.
 */
export const handicapSettingsSchema: z.ZodType<HandicapSettings> = z.object({
  mode: z.enum(['gross', 'net']),
  allowancePct: z.number().min(0).max(200),
  reference: z.enum(['absolute', 'offLow']),
})

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
  z.object({
    type: z.literal('game/configured'),
    gameId: z.string(),
    // NOT validated here, and that is the same call `importSchema` makes about
    // a game's config: only the engine knows its own shape, so the check that
    // matters happens in `amendRound`, against `configSchema`. Validating a
    // guess at it here would refuse an amendment to a game type a NEWER build
    // ships and this one doesn't.
    config: z.unknown(),
    handicap: handicapSettingsSchema,
    role: z.enum(['main', 'side']).optional(),
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
