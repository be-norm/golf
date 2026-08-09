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

/** A game's config for a round, plus the events it emits as holes are scored. */
export interface FuzzGame {
  config: unknown
  /**
   * Per-hole game events, called in log order AFTER that hole's scores are
   * appended — the same interleaving a scorekeeper produces.
   */
  events?: (hole: number, idx: number) => FuzzEvent[]
}

export interface GameFuzz {
  /** must match the registered engine's `type` */
  type: string
  /** can this engine legally join a round of this size? */
  eligible(playerCount: number): boolean
  /**
   * Seeds for this game, resolved into a config once the round's players exist.
   *
   * The two-step shape — an arbitrary of a FUNCTION of ids, rather than an
   * arbitrary taking ids — is what lets the generator keep every random field
   * in ONE flat `fc.record`. Deciding the player count first and generating
   * configs inside a `.chain()` would put the whole round behind a combinator
   * fast-check documents as shrinking poorly, and a suite whose entire value is
   * the MINIMAL counterexample cannot afford that: a real zero-sum bug would
   * report a full 18×4 score matrix instead of the two holes that cause it.
   */
  arbitrary(): fc.Arbitrary<(ids: readonly Uuid[]) => FuzzGame>
}

const skinsFuzz: GameFuzz = {
  type: 'skins',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    fc.boolean().map((carryover) => () => ({ config: { stakeCents: 100, carryover } })),
}

const nassauFuzz: GameFuzz = {
  type: 'nassau',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    fc.boolean().map((autoPress) => (ids) => ({
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

const matchPlayFuzz: GameFuzz = {
  type: 'matchPlay',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    // 2 → singles; at 3 and 4 the boolean picks between an even split and a
    // LONE side. 3v1 is the point: nassau's fuzz never deals it, and it drives
    // `sideStake`'s lone branch at a ×3 multiplier rather than ×2, which is
    // where an uneven settlement would stop summing to zero if it were going to.
    fc.boolean().map((lopsided) => (ids: readonly Uuid[]) => ({
      config: {
        stakeCents: 500,
        teams:
          ids.length === 4
            ? lopsided
              ? { a: [ids[0]!, ids[1]!, ids[2]!], b: [ids[3]!] }
              : { a: [ids[0]!, ids[1]!], b: [ids[2]!, ids[3]!] }
            : ids.length === 3
              ? lopsided
                ? { a: [ids[0]!], b: [ids[1]!, ids[2]!] }
                : { a: [ids[0]!, ids[1]!], b: [ids[2]!] }
              : null,
      },
    })),
}

const sixPointFuzz: GameFuzz = {
  type: 'sixPoint',
  // threesome-only, but it joins the fuzz like every other money game
  eligible: (n) => n === 3,
  arbitrary: () => fc.constant(() => ({ config: { pointCents: 25 } })),
}

const vegasFuzz: GameFuzz = {
  type: 'vegas',
  eligible: (n) => n === 4,
  arbitrary: () =>
    fc.constant((ids: readonly Uuid[]) => ({
      config: {
        pointCents: 10,
        teams: { a: [ids[0]!, ids[2]!], b: [ids[1]!, ids[3]!] },
        birdieFlip: true,
        eagleDouble: true,
      },
    })),
}

const wolfFuzz: GameFuzz = {
  type: 'wolf',
  eligible: (n) => n === 4,
  arbitrary: () =>
    // one pick seed per hole: 0-2 partner index, 3 lone, 4 blind, 5 no pick yet
    fc
      .array(fc.integer({ min: 0, max: 5 }), { minLength: 18, maxLength: 18 })
      .map((seeds) => (ids: readonly Uuid[]) => ({
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
 * The award channel's property coverage (MAI-46), and the only one there is:
 * `ctp/award` is the first game event that carries a PLAYER rather than a
 * choice, and the first that a scorekeeper is expected to enter long after the
 * hole it names. Zero-sum, replay determinism and retraction equivalence all
 * have to survive that.
 *
 * One seed per hole: 0–3 award it to that player, 4 leave it unawarded, 5 award
 * it to a player who ISN'T in the round. The last is the important one — an
 * award naming a ghost must move no money rather than paying nobody a stake the
 * others still lose (which would be zero-sum's first real counterexample).
 * The seeded hole is deliberately NOT filtered to par 3s: an award on a par 4
 * is inert, and the fuzz should keep proving it.
 */
const ctpFuzz: GameFuzz = {
  type: 'ctp',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    fc
      .array(fc.integer({ min: 0, max: 5 }), { minLength: 18, maxLength: 18 })
      .map((seeds) => (ids: readonly Uuid[]) => ({
        config: { stakeCents: 200 },
        events: (hole: number, idx: number) => {
          const seed = seeds[idx]!
          if (seed === 4) return []
          const playerId = seed === 5 ? 'p-nobody' : (ids[seed % ids.length] ?? ids[0]!)
          return [{ kind: 'ctp/award', data: { hole, playerId } }]
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
  ctpFuzz,
  matchPlayFuzz,
]

const PLAYER_NAMES = ['A', 'B', 'C', 'D'] as const

/**
 * A round of 2–4 players with every eligible game, and a log of hole-by-hole
 * scores interleaved with each game's own events.
 *
 * Every random field lives in ONE flat `fc.record` — including the player
 * count — so fast-check can shrink them jointly. Seeds are therefore DRAWN for
 * every registered game and the ineligible ones simply go unused: a few wasted
 * draws, in exchange for minimal counterexamples. See `GameFuzz.arbitrary`.
 *
 * `extra` appends fuzz entries for engines registered by the calling test —
 * used by `replay.guard.test.ts` to prove the suite actually fails on a broken
 * engine. Passing them in beats mutating `GAME_FUZZ`, which would leak between
 * tests in the same file.
 */
export function arbitraryRoundAndEvents(extra: readonly GameFuzz[] = []) {
  const registry = [...GAME_FUZZ, ...extra]
  return fc
    .record({
      playerCount: fc.integer({ min: 2, max: 4 }),
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
      games: fc.tuple(...registry.map((g) => g.arbitrary())),
    })
    .map(({ playerCount, handicaps, net, scores, games }) => {
      const players = makePlayers(
        PLAYER_NAMES.slice(0, playerCount).map((name, i) => ({ name, ch: handicaps[i]! })),
      )
      // READ the ids off the players rather than re-deriving the harness's id
      // scheme. A private copy that drifts would point every `teams` and
      // `rotation` at players who aren't in the round — and the games would
      // still derive, settling $0 for everyone. Zero-sum, determinism and
      // retraction-equivalence would all pass over rounds that test nothing.
      const ids = players.map((p) => p.playerId)
      const handicap: HandicapSettings = net
        ? { mode: 'net', allowancePct: 100, reference: 'offLow' }
        : { mode: 'gross', allowancePct: 100, reference: 'absolute' }

      // Eligibility is decided BEFORE the builder runs, not after. A builder
      // handed a roster its game can't seat indexes past the end — Vegas at two
      // players would compose `teams` out of two ids and two `undefined`s, hidden
      // behind a non-null assertion. Harmless while the result is dropped on the
      // next line, and a live bug the moment anyone validates or logs the games
      // this generator produces.
      const entries = registry
        .map((g, i) => ({ g, build: games[i]! }))
        .filter(({ g }) => g.eligible(playerCount))
        .map(({ g, build }) => ({ type: g.type, game: build(ids) }))

      const round = makeRound({
        players,
        holes: 'full18',
        games: entries.map((e) => ({ type: e.type, config: e.game.config, handicap })),
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
        entries.forEach((e, gi) => {
          if (!e.game.events) return
          const gameId = round.games[gi]!.gameId
          for (const ev of e.game.events(hole, holeIdx)) {
            log.append({ type: 'game/event', gameId, kind: ev.kind, data: ev.data })
          }
        })
      })
      return { round, log }
    })
}
