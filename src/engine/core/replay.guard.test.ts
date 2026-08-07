import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { z } from 'zod'
import '../games/index'
import { deriveRound, registerEngine, type GameEngine } from '../catalog'
import { addLine, assertZeroSum, emptySettlement } from './money'
import { arbitraryRoundAndEvents, type GameFuzz } from '../test/arbitraries'
import { GUARD_ENGINE_TYPE } from '../test/harness'

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
