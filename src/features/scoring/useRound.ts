import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import '../../engine/games'
import { deriveRound } from '../../engine/catalog'
import type { RoundEvent } from '../../engine/core/events'
import type { Round } from '../../engine/core/types'
import { eventStore } from '../../db/eventStore'
import { roundRepo } from '../../db/repos'

export interface RoundView {
  round: Round
  events: RoundEvent[]
  ctx: ReturnType<typeof deriveRound>['ctx']
  derivations: ReturnType<typeof deriveRound>['derivations']
}

/** Live round view: DB is the source of truth; every event append re-derives. */
export function useRound(roundId: string | undefined): RoundView | undefined | null {
  const data = useLiveQuery(async () => {
    if (!roundId) return null
    const round = await roundRepo.get(roundId)
    if (!round) return null
    const events = await eventStore.list(roundId)
    return { round, events }
  }, [roundId])

  return useMemo(() => {
    if (!data) return data
    return { ...data, ...deriveRound(data.round, data.events) }
  }, [data])
}
