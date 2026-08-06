import fc from 'fast-check'
import { EventLog, makePlayers, makeRound } from './harness'
import type { HandicapSettings, Uuid } from '../core/types'

/**
 * The property suite's game registry (MAI-51).
 *
 * `replay.test.ts` guards zero-sum settlements, replay determinism, retraction
 * equivalence and correction equivalence — the invariants CLAUDE.md calls
 * non-negotiable. It used to build its rounds from one hand-written `fc.record`
 * whose fields were per-game (`carryover`, `autoPress`, `pickSeeds`) with games
 * pushed by player-count branches. Fine at five games; at twenty-five it is a
 * shared record nobody wants to touch, and the failure mode is the worst one
 * available: a new game silently stops being covered while CLAUDE.md tells its
 * author a property test has it.
 *
 * So each engine contributes its own arbitrary here instead. Adding a game
 * means adding one entry to `GAME_FUZZ` — and if you forget, the coverage test
 * in `replay.test.ts` fails by name.
 *
 * This is a REGISTRY IN THE TEST LAYER rather than a `testArbitrary` field on
 * `GameEngine`: the production interface every engine implements should not
 * grow a test concern.
 */

export interface FuzzEvent {
  kind: string
  data: Record<string, unknown>
}

export interface GameFuzz {
  /** must match the registered engine's `type` */
  type: string
  /** can this engine legally join a round of this size? */
  eligible(playerCount: number): boolean
  /**
   * This game's config, plus optional per-hole events. `events(hole, idx)` is
   * called in log order, AFTER that hole's scores are appended — the same
   * interleaving a scorekeeper produces.
   */
  arbitrary(ids: readonly Uuid[]): fc.Arbitrary<{
    config: unknown
    events?: (hole: number, idx: number) => FuzzEvent[]
  }>
}

const skinsFuzz: GameFuzz = {
  type: 'skins',
  eligible: (n) => n >= 2,
  arbitrary: () => fc.boolean().map((carryover) => ({ config: { stakeCents: 100, carryover } })),
}

const nassauFuzz: GameFuzz = {
  type: 'nassau',
  eligible: (n) => n >= 2,
  arbitrary: (ids) =>
    fc.boolean().map((autoPress) => ({
      config: {
        stakeCents: 500,
        // 2 → singles, 3 → 2v1 (uneven split), 4 → 2v2. The 2v1 is the point:
        // it exercises the lone-plays-each-opponent settlement, so zero-sum has
        // to hold when the two sides are different sizes.
        teams:
          ids.length === 4
            ? { a: [ids[0]!, ids[1]!], b: [ids[2]!, ids[3]!] }
            : ids.length === 3
              ? { a: [ids[0]!, ids[1]!], b: [ids[2]!] }
              : null,
        autoPress,
      },
    })),
}

const sixPointFuzz: GameFuzz = {
  type: 'sixPoint',
  // threesome-only, but it joins the fuzz like every other money game
  eligible: (n) => n === 3,
  arbitrary: () => fc.constant({ config: { pointCents: 25 } }),
}

const vegasFuzz: GameFuzz = {
  type: 'vegas',
  eligible: (n) => n === 4,
  arbitrary: (ids) =>
    fc.constant({
      config: {
        pointCents: 10,
        teams: { a: [ids[0]!, ids[2]!], b: [ids[1]!, ids[3]!] },
        birdieFlip: true,
        eagleDouble: true,
      },
    }),
}

const wolfFuzz: GameFuzz = {
  type: 'wolf',
  eligible: (n) => n === 4,
  arbitrary: (ids) =>
    // one pick seed per hole: 0-2 partner index, 3 lone, 4 blind, 5 no pick yet
    fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 18, maxLength: 18 }).map((seeds) => ({
      config: { pointCents: 100, rotation: [...ids] },
      events: (hole: number, idx: number) => {
        const seed = seeds[idx]!
        if (seed >= 5) return []
        // the wolf the rotation assigns, mirroring the engine. On the last
        // holes the engine switches to fewest-points, so a seeded pick can go
        // stale there — which is itself worth fuzzing, since a stale pick must
        // fall back to pending rather than compute a degenerate side.
        const wolfId = ids[idx % 4]!
        const others = ids.filter((id) => id !== wolfId)
        const choice = seed < 3 ? others[seed]! : seed === 3 ? 'lone' : 'blind'
        return [{ kind: 'wolf/pick', data: { hole, choice } }]
      },
    })),
}

/**
 * Order matters: it decides the order games sit in `round.games`, and so which
 * `gameId` each one gets. Keep new entries appended.
 */
export const GAME_FUZZ: readonly GameFuzz[] = [
  skinsFuzz,
  nassauFuzz,
  sixPointFuzz,
  vegasFuzz,
  wolfFuzz,
]

const PLAYER_NAMES = ['A', 'B', 'C', 'D'] as const

/** Player ids as `makePlayers` mints them, known before the players exist. */
const idsFor = (playerCount: number): Uuid[] =>
  PLAYER_NAMES.slice(0, playerCount).map((name) => `p-${name.toLowerCase()}`)

/**
 * A round of 2–4 players with every eligible game, and a log of hole-by-hole
 * scores interleaved with each game's own events.
 *
 * `extra` appends fuzz entries for engines registered by the calling test —
 * used by `replay.guard.test.ts` to prove the suite actually fails on a broken
 * engine. Passing them in beats mutating `GAME_FUZZ`, which would leak between
 * tests in the same file.
 */
export function arbitraryRoundAndEvents(extra: readonly GameFuzz[] = []) {
  const registry = [...GAME_FUZZ, ...extra]
  return fc.integer({ min: 2, max: 4 }).chain((playerCount) => {
    const ids = idsFor(playerCount)
    const entries = registry.filter((g) => g.eligible(playerCount))
    return fc
      .record({
        handicaps: fc.array(fc.integer({ min: -3, max: 24 }), { minLength: 4, maxLength: 4 }),
        net: fc.boolean(),
        // per hole per player: gross score or null (unscored)
        scores: fc.array(
          fc.array(fc.option(fc.integer({ min: 1, max: 12 }), { nil: null }), {
            minLength: 4,
            maxLength: 4,
          }),
          { minLength: 1, maxLength: 18 },
        ),
        games: fc.tuple(...entries.map((g) => g.arbitrary(ids))),
      })
      .map(({ handicaps, net, scores, games }) => {
        const players = makePlayers(
          PLAYER_NAMES.slice(0, playerCount).map((name, i) => ({ name, ch: handicaps[i]! })),
        )
        const handicap: HandicapSettings = net
          ? { mode: 'net', allowancePct: 100, reference: 'offLow' }
          : { mode: 'gross', allowancePct: 100, reference: 'absolute' }

        const round = makeRound({
          players,
          holes: 'full18',
          games: entries.map((g, i) => ({ type: g.type, config: games[i]!.config, handicap })),
        })

        const log = new EventLog()
        scores.forEach((byPlayer, holeIdx) => {
          const hole = holeIdx + 1
          players.forEach((p, pi) => {
            const gross = byPlayer[pi]
            if (gross !== null && gross !== undefined) {
              log.append({ type: 'score/set', playerId: p.playerId, hole, gross })
            }
          })
          // each game's own events land after that hole's scores, in log order
          entries.forEach((_, gi) => {
            const emit = games[gi]!.events
            if (!emit) return
            const gameId = round.games[gi]!.gameId
            for (const e of emit(hole, holeIdx)) {
              log.append({ type: 'game/event', gameId, kind: e.kind, data: e.data })
            }
          })
        })
        return { round, log }
      })
  })
}
