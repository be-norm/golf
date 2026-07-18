import { z } from 'zod'
import type { RoundEvent } from '../../engine/core/events'
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

const importSchema = z.object({
  format: z.literal('golf-round'),
  version: z.literal(1),
  round: z.looseObject({ id: z.string() }),
  events: z.array(z.looseObject({ id: z.string(), roundId: z.string(), seq: z.number() })),
})

/** Import a previously exported round. Overwrites any existing copy of the same round. */
export async function importRound(json: string): Promise<Round> {
  const parsed = importSchema.parse(JSON.parse(json))
  const round = parsed.round as unknown as Round
  const events = parsed.events as unknown as RoundEvent[]
  await db.transaction('rw', db.rounds, db.round_events, async () => {
    await db.rounds.put(round)
    await db.round_events.where('roundId').equals(round.id).delete()
    await db.round_events.bulkPut(events)
  })
  return round
}
