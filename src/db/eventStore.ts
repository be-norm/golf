import Dexie from 'dexie'
import { eventDraftSchema, type EventDraft, type RoundEvent } from '../engine/core/events'
import { db as defaultDb, type GolfDB } from './schema'
import { getDeviceId, newId } from './ids'

/**
 * The ONLY write path for round events. Events are immutable and append-only —
 * there is no update or delete, ever. Undo appends a meta/retract.
 */
export class EventStore {
  /** Appends are serialized in-process: one writer at a time, no seq races. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private db: GolfDB = defaultDb) {}

  /** Atomically assign seq numbers and append drafts in one transaction. */
  append(roundId: string, drafts: EventDraft[]): Promise<RoundEvent[]> {
    const run = this.queue.then(() => this.appendNow(roundId, drafts))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async appendNow(roundId: string, drafts: EventDraft[]): Promise<RoundEvent[]> {
    if (drafts.length === 0) return []
    for (const draft of drafts) eventDraftSchema.parse(draft)
    const deviceId = await getDeviceId(this.db)
    const at = new Date().toISOString()

    return this.db.transaction('rw', this.db.round_events, this.db.rounds, async () => {
      const last = await this.db.round_events
        .where('[roundId+seq]')
        .between([roundId, Dexie.minKey], [roundId, Dexie.maxKey])
        .last()
      let seq = last?.seq ?? 0
      const events = drafts.map(
        (draft) =>
          ({
            ...draft,
            id: newId(),
            roundId,
            seq: ++seq,
            at,
            deviceId,
          }) as RoundEvent,
      )
      await this.db.round_events.bulkAdd(events)
      await this.db.rounds.update(roundId, { updatedAt: at })
      return events
    })
  }

  /** All events for a round, ordered by seq. */
  async list(roundId: string): Promise<RoundEvent[]> {
    return this.db.round_events
      .where('[roundId+seq]')
      .between([roundId, Dexie.minKey], [roundId, Dexie.maxKey])
      .toArray()
  }
}

export const eventStore = new EventStore()
