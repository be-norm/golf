import { z } from 'zod'
import { eventDraftSchema, type RoundEvent } from '../../engine/core/events'
import type { Round } from '../../engine/core/types'
import { db } from '../../db/schema'
import { eventStore } from '../../db/eventStore'

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
  a.download = `golf-${data.round.courseSnapshot.name.replace(/\W+/g, '-')}-${data.round.startedAt.slice(0, 10)}.json`
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
    games: z.array(z.looseObject({ gameId: z.string(), type: z.string() })),
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
