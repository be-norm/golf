import type { EventDraft, RoundEvent } from '../core/events'
import type {
  Course,
  GameConfig,
  HandicapSettings,
  Round,
  RoundHoles,
  RoundPlayer,
  Uuid,
} from '../core/types'

/** Deterministic test-only builders — no clocks, no randomness. */

const FIXED_AT = '2026-07-18T12:00:00.000Z'

export function makeCourse(pars: number[], strokeIndexes: number[]): Course {
  if (pars.length !== strokeIndexes.length) throw new Error('pars/SIs length mismatch')
  return {
    id: 'course-1',
    name: 'Test National',
    holeCount: pars.length as 9 | 18,
    holes: pars.map((par, i) => ({ number: i + 1, par, strokeIndex: strokeIndexes[i]! })),
    teeSets: [{ id: 'tee-1', name: 'Blue', rating: 71.2, slope: 125 }],
    source: 'seed',
    updatedAt: FIXED_AT,
    revision: 1,
  }
}

export function makePlayers(defs: { name: string; ch?: number }[]): RoundPlayer[] {
  return defs.map((d) => ({
    playerId: `p-${d.name.toLowerCase()}`,
    name: d.name,
    courseHandicap: d.ch ?? 0,
  }))
}

export interface MakeRoundOpts {
  course?: Course
  players: RoundPlayer[]
  holes?: RoundHoles
  games: Array<Pick<GameConfig, 'type' | 'config'> & { gameId?: Uuid; handicap?: HandicapSettings }>
}

export function makeRound(opts: MakeRoundOpts): Round {
  const course =
    opts.course ??
    makeCourse(
      [4, 4, 5, 3, 4, 4, 3, 5, 4, 4, 5, 3, 4, 4, 5, 3, 4, 4],
      [5, 13, 1, 9, 17, 3, 11, 7, 15, 6, 2, 16, 10, 4, 8, 18, 12, 14],
    )
  return {
    id: 'round-1',
    courseId: course.id,
    courseSnapshot: course,
    teeSetId: course.teeSets[0]!.id,
    holes: opts.holes ?? 'full18',
    players: opts.players,
    games: opts.games.map((g, i) => ({
      gameId: g.gameId ?? `game-${i + 1}`,
      type: g.type,
      handicap: g.handicap ?? { mode: 'gross', allowancePct: 100, reference: 'absolute' },
      config: g.config,
    })),
    status: 'live',
    startedAt: FIXED_AT,
    updatedAt: FIXED_AT,
    deviceId: 'device-test',
    schemaVersion: 1,
  }
}

export class EventLog {
  private seq = 0
  readonly events: RoundEvent[] = []

  constructor(private roundId: Uuid = 'round-1') {}

  append(draft: EventDraft): RoundEvent {
    this.seq += 1
    const event = {
      ...draft,
      id: `evt-${this.seq}`,
      roundId: this.roundId,
      seq: this.seq,
      at: FIXED_AT,
      deviceId: 'device-test',
    } as RoundEvent
    this.events.push(event)
    return event
  }

  /** Interleave hole-by-hole score entry the way a scorekeeper would. */
  scoreByHole(round: Round, scores: Record<string, (number | null)[]>, holes?: number[]): void {
    const nameToId = new Map(round.players.map((p) => [p.name, p.playerId]))
    const holeNumbers =
      holes ??
      Array.from(
        { length: Object.values(scores)[0]?.length ?? 0 },
        (_, i) => (round.holes === 'back9' ? 10 : 1) + i,
      )
    holeNumbers.forEach((hole, holeIdx) => {
      for (const [name, byHole] of Object.entries(scores)) {
        const gross = byHole[holeIdx]
        if (gross === null || gross === undefined) continue
        const playerId = nameToId.get(name)
        if (!playerId) throw new Error(`unknown player ${name}`)
        this.append({ type: 'score/set', playerId, hole, gross })
      }
    })
  }
}
