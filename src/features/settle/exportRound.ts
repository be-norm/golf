import { z } from 'zod'
import { eventDraftSchema, type RoundEvent } from '../../engine/core/events'
import type { Round } from '../../engine/core/types'
import { db } from '../../db/schema'
import { eventStore } from '../../db/eventStore'
import { roundFileBase } from './shareImage'

export interface RoundExport {
  format: 'golf-round'
  version: 1
  round: Round
  events: RoundEvent[]
}

export async function buildExport(round: Round): Promise<RoundExport> {
  return {
    format: 'golf-round',
    version: 1,
    round,
    events: await eventStore.list(round.id),
  }
}

export function downloadExport(data: RoundExport): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${roundFileBase(data.round)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

const envelopeSchema = z.object({
  id: z.string().min(1),
  roundId: z.string().min(1),
  seq: z.number().int().positive(),
  at: z.string(),
  deviceId: z.string(),
})

const importSchema = z.object({
  format: z.literal('golf-round'),
  version: z.literal(1),
  round: z.looseObject({
    id: z.string().min(1),
    players: z.array(z.looseObject({ playerId: z.string() })).min(1),
    games: z
      .array(
        // `role` is validated even though the rest stays loose: it is read back
        // as a two-value union, so an imported 'sausage' would be handed to
        // display rules typed as something it isn't (catalog.ts roleOf).
        z.looseObject({
          gameId: z.string(),
          type: z.string(),
          // `.catch`, not a hard failure: this is the sanctioned restore path
          // for an entire event log (invariant #2), and refusing the round over
          // a cosmetic tag a later build might spell differently would destroy
          // far more than it protects. An unusable value degrades to absent,
          // and `roleOf` derives it.
          role: z.enum(['main', 'side']).optional().catch(undefined),
          // Repaired, never REFUSED — and never invented. `handicap` steers
          // stroke allocation, so a junk value is worth replacing with the
          // neutral one; the allowance is bounded because an unbounded number
          // reaches `applyAllowance` and produces negative playing handicaps
          // for the whole round, silently wrong rather than absent.
          handicap: z
            .looseObject({
              mode: z.enum(['gross', 'net']).catch('gross'),
              allowancePct: z.number().min(0).max(200).catch(100),
              reference: z.enum(['absolute', 'offLow']).catch('absolute'),
            })
            .optional()
            .catch(undefined)
            .transform((h) => h ?? { mode: 'gross' as const, allowancePct: 100, reference: 'absolute' as const }),
          // `config` is deliberately NOT coerced. Defaulting it to `{}` looks
          // like a repair and is worse than the crash it replaces: skins then
          // destructures `stakeCents` to undefined and settles NaN, which is
          // zero-sum-false money nobody can see is wrong. `deriveRound` makes a
          // game whose config its engine rejects inert instead. Left optional
          // so a file omitting it still imports — coercing it here also made
          // the whole round un-restorable, since a missing key is `undefined`
          // and a bare transform is non-optional in zod.
          config: z.unknown().optional(),
        }),
      )
      // gameId is the key `deriveRound` files derivations under, so a duplicate
      // collapses two games into one Map entry: the settle screen then sums ONE
      // settlement and under-reports what everybody is owed, while the round
      // renders the same panel twice. Structurally impossible, so refused —
      // same treatment as the duplicate-`seq` check below.
      .refine((games) => new Set(games.map((g) => g.gameId)).size === games.length, {
        message: 'duplicate gameId',
      }),
    courseSnapshot: z.looseObject({ holes: z.array(z.unknown()).min(1) }),
  }),
  events: z.array(z.unknown()),
})

/**
 * Import a previously exported round, replacing any existing copy of the SAME
 * round wholesale. This is the one sanctioned exception to the append-only
 * event rule (documented in CLAUDE.md): a restore replaces an entire round's
 * log atomically — it never edits events within a live log. Every event is
 * validated (envelope + payload) and must belong to the imported round.
 *
 * The imported round is stamped with `userId` so it lands under the importer's
 * account (or the guest partition), not whatever owner the export file carried.
 */
export async function importRound(json: string, userId: string): Promise<Round> {
  const parsed = importSchema.parse(JSON.parse(json))
  const round = { ...(parsed.round as unknown as Round), userId }

  const events = parsed.events.map((raw, i) => {
    const envelope = envelopeSchema.parse(raw)
    if (envelope.roundId !== round.id) {
      throw new Error(`event ${i} belongs to a different round — refusing to import`)
    }
    // validate the payload half against the same schema live appends use
    eventDraftSchema.parse(raw)
    return raw as RoundEvent
  })
  const seqs = new Set(events.map((e) => e.seq))
  if (seqs.size !== events.length) throw new Error('duplicate event seq in export')

  await db.transaction('rw', db.rounds, db.round_events, async () => {
    await db.rounds.put(round)
    await db.round_events.where('roundId').equals(round.id).delete()
    await db.round_events.bulkPut(events)
  })
  return round
}
