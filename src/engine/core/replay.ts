import type { RoundEvent, GameScopedEvent } from './events'
import type { Round, Uuid } from './types'

/**
 * Retraction pass: drop every event targeted by a meta/retract, and the retracts
 * themselves. Engines never see retracted events, so undo of anything — a score,
 * a wolf pick, a press — is one uniform mechanism. Result is ordered by seq.
 */
export function effectiveEvents(events: readonly RoundEvent[]): RoundEvent[] {
  const retracted = new Set<Uuid>()
  for (const e of events) {
    if (e.type === 'meta/retract') retracted.add(e.targetEventId)
  }
  const kept = events.filter((e) => e.type !== 'meta/retract' && !retracted.has(e.id))
  // EventStore.list yields seq order already — only pay for a sort when needed
  for (let i = 1; i < kept.length; i++) {
    if (kept[i]!.seq < kept[i - 1]!.seq) return kept.sort((a, b) => a.seq - b.seq)
  }
  return kept
}

/**
 * Fold the gross scorecard from effective score events.
 * Last write (by seq) wins per (player, hole); score/clear removes the entry.
 */
export function deriveGross(
  effective: readonly RoundEvent[],
): Map<Uuid, Map<number, number>> {
  const gross = new Map<Uuid, Map<number, number>>()
  for (const e of effective) {
    if (e.type === 'score/set') {
      let byHole = gross.get(e.playerId)
      if (!byHole) {
        byHole = new Map()
        gross.set(e.playerId, byHole)
      }
      byHole.set(e.hole, e.gross)
    } else if (e.type === 'score/clear') {
      gross.get(e.playerId)?.delete(e.hole)
    }
  }
  return gross
}

export function gameEventsFor(
  effective: readonly RoundEvent[],
  gameId: Uuid,
): GameScopedEvent[] {
  return effective.filter(
    (e): e is GameScopedEvent => e.type === 'game/event' && e.gameId === gameId,
  )
}

export function isCompleted(round: Round, effective: readonly RoundEvent[]): boolean {
  let completed = round.status === 'completed'
  for (const e of effective) {
    if (e.type === 'round/completed') completed = true
    else if (e.type === 'round/reopened') completed = false
  }
  return completed
}
