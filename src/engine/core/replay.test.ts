import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import '../games/index'
import { deriveRound, getEngine, listEngines } from '../catalog'
import { EventLog, makePlayers, makeRound, TEST_ONLY_ENGINE_TYPES } from '../test/harness'
import { arbitraryRotationPair, arbitraryRoundAndEvents, GAME_FUZZ } from '../test/arbitraries'
import { buildHoleLedger } from '../ledger'
import { assertZeroSum, minimalTransfers } from './money'
import type { RoundEvent } from './events'
import { effectiveEvents } from './replay'

describe('replay invariants (fast-check)', () => {
  it('settlements are always zero-sum, and only ever pay the round', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), ({ round, log }) => {
        const roster = new Set(round.players.map((p) => p.playerId))
        const { derivations } = deriveRound(round, log.events)
        for (const d of derivations.values()) {
          assertZeroSum(d.settlement)
          // …and to somebody who is actually playing. `assertZeroSum` sums the
          // settlement's OWN keys, so a payment to a player who isn't in the
          // round balances against them and reads as zero — while the surfaces
          // that show the money build from `round.players` and see a credit
          // with no debit. `addLine` refuses such a line, but it is not the
          // only write path (wolf assigns `perPlayerCents` directly), so the
          // rule is asserted over every registered engine here rather than
          // trusted to one helper.
          for (const id of Object.keys(d.settlement.perPlayerCents)) {
            expect(roster.has(id), `settlement pays "${id}", who is not in the round`).toBe(true)
          }
        }
      }),
    )
  })

  /**
   * `settlement.lines` is the record of money that MOVED. A zero-cent row in it
   * is a category error: it makes `lines.length === 0` — the settle screen's
   * "No money moved." signal — false for a round where no money moved, and it
   * hands every consumer that counts or sums lines a phantom entry.
   *
   * Skins broke this reaching for somewhere to say "3 skins died unwon"; the
   * fix was a `notes` channel on the derivation, and this is the guard that
   * keeps the next game from reaching for the same shortcut (MAI-40).
   */
  it('every settlement line moves money', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), ({ round, log }) => {
        const { derivations } = deriveRound(round, log.events)
        for (const [gameId, d] of derivations) {
          // WOLF IS A KNOWN EXCEPTION, not a silently weakened rule — see the
          // test below, which fails the moment MAI-75 fixes it and so forces
          // this skip to be deleted rather than outliving the bug it names.
          if (round.games.find((g) => g.gameId === gameId)?.type === 'wolf') continue
          for (const line of d.settlement.lines) {
            const moved = Object.values(line.perPlayerCents).some((c) => c !== 0)
            expect(moved, `settlement line moved nothing: "${line.label}"`).toBe(true)
          }
        }
      }),
    )
  })

  /**
   * A newly registered engine would otherwise be invisible to every property
   * above while CLAUDE.md tells its author a test enforces them. These two
   * catch that, and they catch different halves of it — keep both.
   *
   * This one names the omission outright: register an engine, forget its entry
   * in `GAME_FUZZ` (src/engine/test/arbitraries.ts), and the failure says so.
   */
  it('every registered engine contributes an arbitrary', () => {
    // engines registered by sibling test FILES are excluded by name rather than
    // by trusting vitest to isolate modules — see TEST_ONLY_ENGINE_TYPES
    const registered = listEngines()
      .map((e) => e.type)
      .filter((t) => !TEST_ONLY_ENGINE_TYPES.includes(t))
    expect(new Set(GAME_FUZZ.map((g) => g.type))).toEqual(new Set(registered))
  })

  /**
   * A fuzz entry whose config the engine rejects would leave the game inert —
   * Nassau sides that post no scores, a Wolf rotation naming nobody — and every
   * property above would pass over rounds that exercise nothing. Cheaper to
   * check once here than inside the generator, which runs thousands of times.
   */
  it('every fuzzed config is one its engine would actually accept', () => {
    for (const playerCount of [2, 3, 4]) {
      const { round } = fc
        .sample(arbitraryRoundAndEvents(), { numRuns: 40, seed: 7 })
        .find((s) => s.round.players.length === playerCount)!
      for (const game of round.games) {
        const engine = getEngine(game.type)!
        expect(engine.configSchema.safeParse(game.config).success, `${game.type} config`).toBe(true)
        // Real siblings, not []: the fuzz deals every eligible game into one
        // round, so this also asserts none of them mistake a peer for a
        // duplicate of itself (MAI-45).
        expect(
          engine.validateSetup(
            game,
            round.players,
            round.games.filter((g) => g.gameId !== game.gameId),
          ),
          `${game.type} setup`,
        ).toEqual([])
      }
    }
  })

  /**
   * And this one proves the entries actually admit their game into rounds — an
   * `eligible` that never returns true would satisfy the test above while
   * covering nothing.
   */
  it('the fuzz actually deals every registered engine', () => {
    // Across samples, not within one round: Six Point is threesome-only while
    // Wolf and Vegas need a foursome, so no single round can hold all five.
    const seen = new Set(
      fc
        .sample(arbitraryRoundAndEvents(), { numRuns: 200 })
        .flatMap(({ round }) => round.games.map((g) => g.type)),
    )
    expect(seen).toEqual(
      new Set(
        listEngines()
          .map((e) => e.type)
          .filter((t) => !TEST_ONLY_ENGINE_TYPES.includes(t)),
      ),
    )
  })

  /**
   * A DIMENSION THAT NEVER FIRES IS COVERAGE THEATRE — the same reason "the
   * fuzz actually deals every registered engine" sits two tests up.
   *
   * Putts and completion were both added for Snake (MAI-58), and both are easy
   * to add in a shape that generates nothing: a seed range that never reaches
   * the clear, a boolean read but never appended. Completion in particular went
   * unfuzzed for the whole catalog until now — Skins' dead carry, the award
   * games' unclaimed holes and Wolf's missing picks all hang off it — so the
   * one thing worse than not dealing it is believing we do.
   */
  it('the fuzz actually deals putts, clears, and rounds that finish', () => {
    for (const [name, arb] of [
      ['rounds', arbitraryRoundAndEvents()],
      // the rotation pair is a SECOND literal of the same shape and can drift
      // from the first; it is the only property that can see a positional bug,
      // so a putt it never deals is a three-putt Snake never has to place
      ['rotation pair', arbitraryRotationPair().map((p) => p.wrapped)],
    ] as const) {
      const samples = fc.sample(arb, { numRuns: 200 })
      const kinds = new Set(samples.flatMap(({ log }) => log.events.map((e) => e.type)))
      for (const kind of ['score/putts', 'score/puttsClear', 'round/completed']) {
        expect(kinds, `${name} never deal ${kind}`).toContain(kind)
      }
      // …and not ALWAYS finished, or the live half stops being covered — which
      // is the half where an award is still tappable and a snake still moves
      expect(
        samples.some(({ log }) => !log.events.some((e) => e.type === 'round/completed')),
        `${name} always finish`,
      ).toBe(true)
    }

    /**
     * …and the dealt facts actually reach a settlement. Snake settles only on a
     * completed round on which somebody three-putted, so every property above
     * — zero-sum, determinism, retraction equivalence, the rotation pair —
     * would hold VACUOUSLY over a Snake that never moved a cent. This is the
     * same question `catalog.test.ts` asks with "moved no money — the guard
     * proves nothing", asked of the generator instead of the fixture.
     */
    const settled = fc
      .sample(arbitraryRoundAndEvents(), { numRuns: 200 })
      .some(({ round, log }) => {
        const gameId = round.games.find((g) => g.type === 'snake')?.gameId
        if (!gameId) return false
        const d = deriveRound(round, log.events).derivations.get(gameId)
        return Object.values(d?.settlement.perPlayerCents ?? {}).some((c) => c !== 0)
      })
    expect(settled, 'the fuzz never makes a putt-driven game settle').toBe(true)
  })

  /**
   * A KNOWN VIOLATION, asserted so it self-retires. Wolf itemises per-player
   * points ("A — 3 pts") rather than per-transaction money, so a player whose
   * points land on the average nets zero and still earns a settlement row.
   *
   * This test exists to fail when MAI-75 fixes that — at which point the Wolf
   * skip in "every settlement line moves money" must be deleted, and this test
   * with it. A bare `continue` up there would have quietly outlived the bug.
   */
  it('Wolf still emits zero-money settlement lines (MAI-75 — delete this when fixed)', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
      holes: 'front9',
      games: [
        { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
      ],
    })
    // nothing scored: every player sits on 0 points, so every row moves $0
    const { derivations } = deriveRound(round, new EventLog().events)
    const lines = derivations.get('game-1')!.settlement.lines
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => Object.values(l.perPlayerCents).every((c) => c === 0))).toBe(true)
  })

  it('replay is deterministic: same events, same result', () => {
    fc.assert(
      fc.property(arbitraryRoundAndEvents(), ({ round, log }) => {
        const a = deriveRound(round, log.events)
        const b = deriveRound(round, [...log.events])
        expect([...a.derivations.values()].map((d) => d.settlement)).toEqual(
          [...b.derivations.values()].map((d) => d.settlement),
        )
      }),
    )
  })

  it('retract(e) is equivalent to a log that never contained e', () => {
    fc.assert(
      fc.property(
        arbitraryRoundAndEvents().filter(({ log }) => log.events.length > 0),
        fc.nat(),
        ({ round, log }, pick) => {
          const target = log.events[pick % log.events.length]!
          const withRetract: RoundEvent[] = [
            ...log.events,
            {
              type: 'meta/retract',
              targetEventId: target.id,
              id: 'evt-retract',
              roundId: round.id,
              seq: log.events.length + 1,
              at: '2026-07-18T12:00:00.000Z',
              deviceId: 'device-test',
            },
          ]
          const without = log.events.filter((e) => e.id !== target.id)
          const a = deriveRound(round, withRetract)
          const b = deriveRound(round, without)
          expect([...a.derivations.values()].map((d) => d.settlement)).toEqual(
            [...b.derivations.values()].map((d) => d.settlement),
          )
        },
      ),
    )
  })

  it('correction equivalence: a corrected score equals having entered it right initially', () => {
    fc.assert(
      fc.property(
        arbitraryRoundAndEvents(),
        fc.integer({ min: 1, max: 12 }),
        ({ round, log }, corrected) => {
          const scoreEvents = log.events.filter((e) => e.type === 'score/set')
          if (scoreEvents.length === 0) return
          const target = scoreEvents[0]!
          const correctionLog = new EventLog()
          for (const e of log.events) {
            if (e.type !== 'score/set') continue
            correctionLog.append({
              type: 'score/set',
              playerId: e.playerId,
              hole: e.hole,
              gross: e.gross,
            })
          }
          correctionLog.append({
            type: 'score/set',
            playerId: target.playerId,
            hole: target.hole,
            gross: corrected,
          })

          const directLog = new EventLog()
          for (const e of log.events) {
            if (e.type !== 'score/set') continue
            directLog.append(
              e.id === target.id
                ? { type: 'score/set', playerId: e.playerId, hole: e.hole, gross: corrected }
                : { type: 'score/set', playerId: e.playerId, hole: e.hole, gross: e.gross },
            )
          }

          const a = deriveRound(round, correctionLog.events)
          const b = deriveRound(round, directLog.events)
          expect([...a.derivations.values()].map((d) => d.settlement)).toEqual(
            [...b.derivations.values()].map((d) => d.settlement),
          )
        },
      ),
    )
  })
})

/**
 * Position, not hole number (CLAUDE.md invariant 9, MAI-41).
 *
 * Separate from the block above because it is a different KIND of property.
 * Everything up there is order-blind — it would pass unchanged if every engine
 * confused a hole's number with its place in the round — which is precisely how
 * Match Play came to settle nine holes early while balancing to the cent.
 *
 * This one compares two rounds that are the same golf played on differently
 * numbered tee markers, so an engine that reads the numbers where it means the
 * places has nowhere to hide. See `arbitraryRotationPair`.
 */
describe('a wrapped round is the same golf as a straight one (fast-check)', () => {
  it('every engine settles a rotated round exactly as it settles the straight one', () => {
    fc.assert(
      fc.property(arbitraryRotationPair(), ({ startHole, wrapped, straight }) => {
        const a = deriveRound(wrapped.round, wrapped.log.events).derivations
        const b = deriveRound(straight.round, straight.log.events).derivations

        expect(a.size).toBe(b.size)
        for (const [gameId, da] of a) {
          const db = b.get(gameId)!
          const type = wrapped.round.games.find((g) => g.gameId === gameId)!.type
          expect(
            da.settlement.perPlayerCents,
            `${type} settles differently from hole ${startHole} than from hole 1`,
          ).toEqual(db.settlement.perPlayerCents)
        }
      }),
    )
  })

  /**
   * …and lands it on the same holes, which the totals above cannot see.
   *
   * `buildHoleLedger` replays a prefix per hole, so a positional slip there
   * moves money to the wrong ROW while the final settlement stays identical —
   * exactly the failure the old numeric prefix produced, and invisible to every
   * other property here. Compared by POSITION in the walk, since the two cards
   * number the same hole differently by construction.
   *
   * Summaries are compared only for PRESENCE: they are prose and quote hole
   * numbers ("Press @12"), so the strings differ for a correct engine while
   * whether a hole had something to say must not.
   */
  it('lands the money on the same holes of the walk, not just the same total', () => {
    fc.assert(
      fc.property(arbitraryRotationPair(), ({ startHole, wrapped, straight }) => {
        const shape = (r: { round: typeof wrapped.round; log: typeof wrapped.log }) => {
          const { ctx, derivations } = deriveRound(r.round, r.log.events)
          const at = new Map(ctx.holesPlayed.map((h, i) => [h, i]))
          return new Map(
            [...buildHoleLedger(r.round, r.log.events, ctx, derivations)].map(([gameId, rows]) => [
              gameId,
              rows.map((row) => ({
                position: at.get(row.hole),
                deltas: row.deltas,
                runningCents: row.runningCents,
                said: row.summary.length > 0,
              })),
            ]),
          )
        }
        const a = shape(wrapped)
        const b = shape(straight)

        for (const [gameId, rowsA] of a) {
          const type = wrapped.round.games.find((g) => g.gameId === gameId)!.type
          expect(
            rowsA,
            `${type}'s ledger differs by position from hole ${startHole} vs hole 1`,
          ).toEqual(b.get(gameId))
        }
      }),
    )
  })

  /**
   * The pair really is the same golf — a guard on the generator, not on the
   * engines. If the renumbered card ever stopped presenting the same pars and
   * stroke indexes in the same order, the property above would compare two
   * different rounds and pass by luck.
   */
  it('the two cards present the same holes in the same order', () => {
    fc.assert(
      fc.property(arbitraryRotationPair(), ({ wrapped, straight }) => {
        const a = deriveRound(wrapped.round, []).ctx
        const b = deriveRound(straight.round, []).ctx
        expect(a.holesPlayed).toHaveLength(18)
        expect(b.holesPlayed).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
        expect(a.holesPlayed.map((h) => a.par(h))).toEqual(b.holesPlayed.map((h) => b.par(h)))
        expect(a.holesPlayed.map((h) => a.strokeIndex(h))).toEqual(
          b.holesPlayed.map((h) => b.strokeIndex(h)),
        )
      }),
    )
  })
})

describe('effectiveEvents', () => {
  it('drops retracted events and retracts themselves', () => {
    const log = new EventLog()
    const e1 = log.append({ type: 'score/set', playerId: 'p-a', hole: 1, gross: 4 })
    log.append({ type: 'score/set', playerId: 'p-b', hole: 1, gross: 5 })
    log.append({ type: 'meta/retract', targetEventId: e1.id })
    const effective = effectiveEvents(log.events)
    expect(effective).toHaveLength(1)
    expect(effective[0]).toMatchObject({ playerId: 'p-b' })
  })
})

describe('minimalTransfers', () => {
  it('settles a zero-sum balance with minimal greedy transfers', () => {
    const transfers = minimalTransfers({ a: 800, b: -400, c: 400, d: -800 })
    const net: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 }
    for (const t of transfers) {
      net[t.fromPlayerId]! -= t.cents
      net[t.toPlayerId]! += t.cents
    }
    expect(net).toEqual({ a: 800, b: -400, c: 400, d: -800 })
    expect(transfers.length).toBeLessThanOrEqual(3)
  })
})
