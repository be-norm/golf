import { z } from 'zod'
import type { GameConfig, HandicapSettings, Uuid } from './types'

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
 * amendment that omits it clears a stamp the round was carrying, so the writer
 * has to send whatever the round should still hold. Today's editor changes only
 * one game's settings and re-sends the stamp it found, which is right because
 * `roleOf` keys off SIBLING categories and an amendment cannot change those.
 * Adding or removing a game can (MAI-103), and that writer will have to
 * reconcile the roles it disturbs.
 */
export type GameConfiguredEvent = EventEnvelope & {
  type: 'game/configured'
  gameId: Uuid
  config: unknown
  handicap: HandicapSettings
  role?: 'main' | 'side'
}

/**
 * ONE PLAYER'S COURSE HANDICAP, CHANGED FOR THE WHOLE ROUND (MAI-100/102).
 *
 * The same shape as `game/configured` and for the same reason — the number
 * lives on the round DOCUMENT, so before this it could only be edited while the
 * log was EMPTY, enforced inside `roundRepo.setCourseHandicap`'s own
 * transaction. That rule was right while there was no honest way to change a
 * handicap under a live log: it silently re-derives every settled hole.
 *
 * Now there is one, so the exception is gone and this replaces it on every
 * path, the first tee included. What made document-rewriting dishonest was that
 * it was SILENT; an amendment is stated, previewed, undoable, and carried by
 * sync and export like everything else in the log.
 *
 * `courseHandicap` and NOT `handicapIndex`: the index records what the player
 * reported and is never re-derived, while this is the number the engine
 * consumes (`RoundPlayer.courseHandicap`). Correcting a round is not a claim
 * about anybody's WHS record.
 */
export type PlayerHandicapEvent = EventEnvelope & {
  type: 'player/handicap'
  playerId: Uuid
  courseHandicap: number
}

/**
 * A GAME JOINING THE ROUND MID-WAY, or coming back after a removal (MAI-103).
 *
 * "We forgot to add the snake" — noticed on the 8th. It scores holes 1–7 the
 * same way an amended stake re-prices them: retroactively, because that is what
 * the group means. An awards game (CTP, Long Drive, Snake) arrives with those
 * holes unrecorded, which the grid lets them fill in — awards never expire
 * before `round/completed`.
 *
 * PUT BY `gameId`, not appended, and that is what keeps `amendRound` idempotent
 * for `buildHoleLedger`'s re-fold. It also makes RESTORE fall out: re-adding a
 * removed game under its original id brings its own recorded events back to
 * life with it, since they were never deleted — only the game they belong to
 * stopped being in the round.
 *
 * Ignored when that id is already present with a DIFFERENT `type`: swapping a
 * Skins for a Wolf under one id would re-interpret the first game's events as
 * the second's, which is the same class of lie the locked-field rule refuses.
 */
export type GameAddedEvent = EventEnvelope & {
  type: 'game/added'
  game: GameConfig
}

/**
 * A GAME LEAVING THE ROUND — "we're not actually playing the Nassau" (MAI-103).
 *
 * Its money comes off the card entirely. Its own recorded events STAY in the
 * log, untouched: nothing is ever deleted here, and that is exactly what lets
 * `game/added` put it back with its presses, awards and bites intact.
 */
export type GameRemovedEvent = EventEnvelope & {
  type: 'game/removed'
  gameId: Uuid
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
  | GameAddedEvent
  | GameRemovedEvent
  | PlayerHandicapEvent
  | RoundCompletedEvent
  | RoundReopenedEvent
  | RetractEvent
  | GameScopedEvent

/**
 * THE AMENDMENT KINDS — a change to the round's SETTINGS rather than to what
 * happened on a hole (MAI-100).
 *
 * One list, because two things have to agree about it: `amendRound`, which
 * folds them, and the scoring screen's undo, which must NOT.
 *
 * That second one is the reason this exists. `↩ Undo` sits in the scoring
 * header beside the score entry, and it means "take back what I just did HERE".
 * Retracting the log's tail regardless of kind made it silently revert a stake
 * somebody had changed on the settings screen — a different surface, possibly
 * minutes earlier, moving every hole's money — off a button the scorekeeper
 * reads as "undo that last tap". Each surface undoes its own kind of action;
 * settings are changed back where they were changed.
 *
 * The mechanism is unaffected: a `meta/retract` still reverts an amendment
 * perfectly, and `game/removed` has `Restore` on the settings screen. What
 * changed is which button reaches for it.
 */
export const AMENDMENT_TYPES = [
  'game/configured',
  'game/added',
  'game/removed',
  'player/handicap',
] as const satisfies readonly RoundEvent['type'][]

/** Is this a settings change rather than something that happened on a hole? */
export function isAmendment(e: RoundEvent): boolean {
  return (AMENDMENT_TYPES as readonly string[]).includes(e.type)
}

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
 * NOTE THAT `eventDraftSchema` IS SHARED WITH IMPORT, so this bound is a
 * refusal there rather than a repair: `importRound` parses every event and
 * throws, while the same field on `round.games[].handicap` is repaired to 100
 * three lines away in `importSchema`. That asymmetry is the event log's
 * existing policy, not a new one — a `score/set` of 40 already aborts a restore
 * — but it is worth knowing that a hand-edited export can fail to import on a
 * value the document half would have quietly fixed.
 *
 * It is also NOT the last line of defence, because the sync path validates
 * nothing at all (`applyRemoteRound` bulk-puts pulled events). `amendRound`
 * re-checks this before letting a handicap reach stroke allocation.
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
  z.object({
    type: z.literal('player/handicap'),
    playerId: z.string(),
    /**
     * THE FAT-FINGER BOUND, and the one place it lives (MAI-102).
     *
     * The upper bound sits above any real WHS course handicap — a 54.0 index on
     * a steep slope lands in the low 70s — so a legitimate value is never
     * clipped, while "142" is refused. It used to be `clampHandicap` in
     * `RoundStartScreen`; it belongs here now that the number travels as an
     * event, for `score/set`'s reason: the log is forever, and the sync path
     * validates nothing.
     */
    courseHandicap: z.number().int().min(-10).max(74),
  }),
  z.object({
    type: z.literal('game/added'),
    // The game's SHAPE only, exactly as `importSchema` validates one: `config`
    // is the engine's business (checked in `amendRound`), and a `type` this
    // build doesn't ship must still round-trip rather than abort a restore.
    game: z.looseObject({
      gameId: z.string(),
      type: z.string(),
      handicap: handicapSettingsSchema,
      config: z.unknown(),
      role: z.enum(['main', 'side']).optional(),
    }),
  }),
  z.object({ type: z.literal('game/removed'), gameId: z.string() }),
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
