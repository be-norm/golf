import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { z } from 'zod'
import '../games/index'
import { deriveRound, registerEngine, type GameEngine } from '../catalog'
import { addLine, assertZeroSum, emptySettlement } from './money'
import { arbitraryRotationPair, arbitraryRoundAndEvents, type GameFuzz } from '../test/arbitraries'
import { GUARD_ENGINE_TYPE, ROTATION_GUARD_ENGINE_TYPE } from '../test/harness'

/**
 * Is the alarm wired to anything?
 *
 * `replay.test.ts` asserts that every settlement is zero-sum, and it has passed
 * since the day it was written — which is exactly the shape of a test that
 * silently stopped running. This registers an engine that invents money out of
 * nothing and proves the property FAILS on it (MAI-51).
 *
 * The bogus engine is registered into the module-global registry, and there is
 * no unregister. Vitest isolates modules per test FILE, so it does not reach the
 * real suite — but that is a CONFIG DEFAULT, not a guarantee: flipping `isolate`
 * in vitest.config.ts would leak it. So the two tests it could break are both
 * defended by name instead of by isolation. `replay.test.ts` excludes
 * GUARD_ENGINE_TYPE from its every-engine-has-an-arbitrary check, and this
 * engine ships complete `meta.rules` so `catalog.test.ts` stays green too.
 */
const brokenEngine: GameEngine<{ stakeCents: number }> = {
  type: GUARD_ENGINE_TYPE,
  meta: {
    name: 'Broken',
    blurb: 'Test-only engine that pays a player from nowhere.',
    minPlayers: 2,
    maxPlayers: 4,
    category: 'main',
    family: 'pot',
    shapes: ['solo'],
    rules: {
      tagline: 'Deliberately not zero-sum, so the property suite has something to catch.',
      howToPlay: ['Exists only inside replay.guard.test.ts.'],
      scoring: ['Pays the first player 100 cents that nobody funds.'],
      terms: [{ term: 'Broken', def: 'Not a real game.' }],
    },
  },
  configSchema: z.object({ stakeCents: z.number().int().positive() }),
  configFields: [],
  defaultConfig: () => ({ stakeCents: 100 }),
  defaultHandicap: () => ({ mode: 'gross', allowancePct: 100, reference: 'absolute' }),
  validateSetup: () => [],
  eventKinds: {},
  derive: (game, _events, ctx) => {
    const playerIds = ctx.round.players.map((p) => p.playerId)
    const settlement = emptySettlement(playerIds)
    // one player collects; nobody pays. This is the bug the suite must see.
    addLine(settlement, {
      label: 'money from nowhere',
      perPlayerCents: { [playerIds[0]!]: game.config.stakeCents },
    })
    return {
      standings: [],
      summary: '',
      holeSummary: () => [],
      requiredInputs: () => [],
      settlement,
    }
  },
}

const brokenFuzz: GameFuzz = {
  type: GUARD_ENGINE_TYPE,
  eligible: () => true,
  arbitrary: () => fc.constant(() => ({ config: { stakeCents: 100 } })),
}

/**
 * The same question for the ROTATION property (MAI-41).
 *
 * `arbitraryRotationPair` is the only thing enforcing "compare position in
 * `ctx.holesPlayed`, never hole number" — CLAUDE.md invariant 9 names it as
 * such. It has passed since the day it was written, which is the exact shape
 * this file exists to distrust, and it needs its own broken engine rather than
 * inheriting confidence from the zero-sum one: an engine can be scrupulously
 * zero-sum while settling entirely the wrong holes.
 *
 * So: a game that pays out over "the front nine" read as `h <= 9` — a hole
 * NUMBER test standing in for a position. Perfectly balanced, perfectly
 * deterministic, perfectly wrong on a round that teed off anywhere but the
 * first tee, where holes 1–9 are the last nine walked. This is a miniature of
 * the real `segmentSpans` bug.
 */
const numberlyEngine: GameEngine<{ stakeCents: number }> = {
  type: ROTATION_GUARD_ENGINE_TYPE,
  meta: {
    name: 'Numberly',
    blurb: 'Test-only engine that mistakes a hole number for a position.',
    minPlayers: 2,
    maxPlayers: 4,
    category: 'main',
    family: 'match',
    shapes: ['solo'],
    rules: {
      tagline: 'Deliberately reads hole numbers as positions, so the rotation property can catch it.',
      howToPlay: ['Exists only inside replay.guard.test.ts.'],
      scoring: ['Pays the first player over holes numbered 1–9, whenever they were played.'],
      terms: [{ term: 'Numberly', def: 'Not a real game.' }],
    },
  },
  configSchema: z.object({ stakeCents: z.number().int().positive() }),
  configFields: [],
  defaultConfig: () => ({ stakeCents: 100 }),
  defaultHandicap: () => ({ mode: 'gross', allowancePct: 100, reference: 'absolute' }),
  validateSetup: () => [],
  eventKinds: {},
  derive: (game, _events, ctx) => {
    const playerIds = ctx.round.players.map((p) => p.playerId)
    const settlement = emptySettlement(playerIds)
    const [a, b] = playerIds
    // THE BUG, and the only line that matters: the first nine WALKED would be
    // `ctx.holesPlayed.slice(0, 9)`. This asks the card instead.
    let cents = 0
    for (const hole of ctx.holesPlayed.filter((h) => h <= 9)) {
      const ga = ctx.gross.get(a!)?.get(hole)
      const gb = ctx.gross.get(b!)?.get(hole)
      if (ga === undefined || gb === undefined || ga === gb) continue
      cents += ga < gb ? game.config.stakeCents : -game.config.stakeCents
    }
    if (cents !== 0) {
      addLine(settlement, { label: 'front nine', perPlayerCents: { [a!]: cents, [b!]: -cents } })
    }
    return {
      standings: [],
      summary: '',
      holeSummary: () => [],
      requiredInputs: () => [],
      settlement,
    }
  },
}

const numberlyFuzz: GameFuzz = {
  type: ROTATION_GUARD_ENGINE_TYPE,
  eligible: (n) => n >= 2,
  arbitrary: () => fc.constant(() => ({ config: { stakeCents: 100 } })),
}

describe('the rotation property catches an engine that reads hole numbers', () => {
  it('fails on a game whose "front nine" is a number test, not a position', () => {
    registerEngine(numberlyEngine)

    // exactly the property replay.test.ts runs, over pairs that now include an
    // engine confusing a hole's number with its place in the round
    expect(() =>
      fc.assert(
        fc.property(arbitraryRotationPair([numberlyFuzz]), ({ wrapped, straight }) => {
          const a = deriveRound(wrapped.round, wrapped.log.events).derivations
          const b = deriveRound(straight.round, straight.log.events).derivations
          for (const [gameId, da] of a) {
            expect(da.settlement.perPlayerCents).toEqual(b.get(gameId)!.settlement.perPlayerCents)
          }
        }),
      ),
    ).toThrow(/Property failed/)
  })

  /**
   * …and the alarm is specific. Every SHIPPED engine must still agree across
   * the pair on the very same draws — otherwise the test above would pass on a
   * generator that simply deals two unrelated rounds, proving nothing about
   * anybody's positional discipline.
   */
  it('and the disagreement is that engine alone, not the generator', () => {
    registerEngine(numberlyEngine)
    const pairs = fc.sample(arbitraryRotationPair([numberlyFuzz]), { numRuns: 30, seed: 4 })
    const rotated = pairs.filter((p) => p.startHole !== 1)
    // a pair that never rotates would make the whole guard vacuous
    expect(rotated.length).toBeGreaterThan(0)

    let sawTheBug = false
    for (const { wrapped, straight } of rotated) {
      const a = deriveRound(wrapped.round, wrapped.log.events).derivations
      const b = deriveRound(straight.round, straight.log.events).derivations
      for (const [gameId, da] of a) {
        const type = wrapped.round.games.find((g) => g.gameId === gameId)!.type
        const same =
          JSON.stringify(da.settlement.perPlayerCents) ===
          JSON.stringify(b.get(gameId)!.settlement.perPlayerCents)
        if (type === ROTATION_GUARD_ENGINE_TYPE) sawTheBug ||= !same
        else expect(same, `${type} disagreed across the pair`).toBe(true)
      }
    }
    expect(sawTheBug, 'the numberly engine never actually disagreed').toBe(true)
  })
})

describe('the property suite catches a broken engine', () => {
  it('deals the broken engine into rounds and fails the zero-sum property', () => {
    registerEngine(brokenEngine)

    // exactly the property replay.test.ts runs, over rounds that now include
    // an engine paying money nobody put up
    expect(() =>
      fc.assert(
        fc.property(arbitraryRoundAndEvents([brokenFuzz]), ({ round, log }) => {
          const { derivations } = deriveRound(round, log.events)
          for (const d of derivations.values()) assertZeroSum(d.settlement)
        }),
      ),
      // fast-check reports a counterexample rather than echoing the cause, so
      // the mechanism itself is named by the assertions below
    ).toThrow(/Property failed/)

    // an explicit seed: a test written to prove the alarm is reliable must not
    // itself draw a different round on every CI run
    const { round, log } = fc.sample(arbitraryRoundAndEvents([brokenFuzz]), {
      numRuns: 1,
      seed: 1,
    })[0]!
    const { derivations } = deriveRound(round, log.events)
    const broken = round.games.find((g) => g.type === GUARD_ENGINE_TYPE)!
    expect(() => assertZeroSum(derivations.get(broken.gameId)!.settlement)).toThrow(
      /not zero-sum/,
    )

    // and the failure is that engine specifically — not the generator handing
    // every game a malformed round, which would make the guard prove nothing
    for (const [gameId, d] of derivations) {
      if (gameId === broken.gameId) continue
      assertZeroSum(d.settlement)
    }
  })
})
