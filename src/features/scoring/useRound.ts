import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import '../../engine/games'
import { deriveRound } from '../../engine/catalog'
import type { RoundEvent } from '../../engine/core/events'
import type { Round } from '../../engine/core/types'
import { eventStore } from '../../db/eventStore'
import { roundRepo } from '../../db/repos'

export interface RoundView {
  /**
   * The round AS ITS LOG SAYS IT IS — the document with every amendment folded
   * on (`amendRound`). This is what every screen should read: it is why no
   * surface can show a stale stake.
   */
  round: Round
  /**
   * The document, untouched — "as teed off".
   *
   * Almost nothing wants this. It exists for the one question the amended round
   * cannot answer: what a `game/removed` took OUT. Folding a prefix over the
   * amended round can't recover a game the amendment already dropped, so the
   * settings screen's Restore list has to start from the document (MAI-103).
   *
   * NEVER WRITE IT BACK expecting it to carry amendments, and never write the
   * amended one back at all — `roundRepo.setStatus` exists so `finish` and
   * `reopen` don't have to.
   */
  storedRound: Round
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
    // `deriveRound`'s round wins by spread order — that is what makes
    // `view.round` the amended one everywhere, with no call site to remember.
    return { storedRound: data.round, ...data, ...deriveRound(data.round, data.events) }
  }, [data])
}
