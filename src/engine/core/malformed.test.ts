import { describe, expect, it } from 'vitest'
import '../games/index'
import { deriveRound } from '../catalog'
import { EventLog, makePlayers, makeRound } from '../test/harness'
import type { GameConfig, Round } from './types'

/**
 * Rounds that came back from an export file, not from setup.
 *
 * `importRound` validates a game's shape loosely on purpose — a restore is
 * worth more than the fields it is missing (invariant #2's sanctioned path) —
 * so these shapes reach Dexie and then reach every screen. `deriveRound` is the
 * first thing every surface calls, which makes it the only place a guard is
 * worth having: a defence further out (in a label helper, say) never runs,
 * because this throws first.
 */
describe('a malformed game never takes a screen down', () => {
  const withGames = (games: unknown[]): Round => {
    const round = makeRound({
      players: makePlayers([
        { name: 'A', ch: 4 },
        { name: 'B', ch: 0 },
      ]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    return { ...round, games: games as GameConfig[] }
  }

  const scored = (round: Round) => {
    const log = new EventLog()
    log.scoreByHole(round, { A: [4, 5, 3], B: [5, 4, 4] }, [1, 2, 3])
    return deriveRound(round, log.events)
  }

  it('derives a game carrying no handicap at all, as gross', () => {
    const round = withGames([
      { gameId: 'game-1', type: 'skins', config: { stakeCents: 100, carryover: true } },
    ])
    expect(() => scored(round)).not.toThrow()
    const { ctx, derivations } = scored(round)
    // no handicap policy means no strokes, not a crash
    expect(ctx.strokesFor('game-1', 'p-a', 1)).toBe(0)
    expect(derivations.get('game-1')!.settlement.lines.length).toBeGreaterThan(0)
  })

  /**
   * The dangerous shape, because it does not look dangerous: skins destructures
   * `stakeCents` to undefined and settles `skins * undefined` — NaN in every
   * line, NaN through minimalTransfers, and zero-sum quietly false. A game that
   * cannot be scored must move NO money rather than unscoreable money.
   */
  it('makes a game whose config its engine rejects inert, not NaN', () => {
    const round = withGames([{ gameId: 'game-1', type: 'skins', handicap: undefined, config: {} }])
    const { derivations } = scored(round)
    expect(derivations.has('game-1')).toBe(false)
  })

  /**
   * The two team shapes that MINT MONEY, and the reason the non-empty and
   * no-duplicates rules live in `teamsSchema` rather than only in
   * `validateSetup` — which never runs on an imported round.
   *
   * Both are invisible to the property fuzz, because it only ever deals
   * well-formed sides. Both stay zero-sum-looking right up until you add the
   * column up. And both are one hand edit of an export file away.
   */
  describe('a side that cannot exist settles nothing', () => {
    const twoSided = (teams: unknown) =>
      withGames([
        {
          gameId: 'game-1',
          type: 'matchPlay',
          handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
          config: { stakeCents: 500, teams },
        },
      ])

    /**
     * Scored AND FINISHED, unlike the rest of this file: a match only pays once
     * it is DECIDED, and a three-hole prefix of a nine never is. Completing the
     * round finalizes the rest (halved, nobody posted) and closes the match.
     *
     * The guards below do not need that — they assert the game is refused, and
     * `deriveRound` omits it whether or not it would have settled. The CONTROL
     * needs it. Against an undecided match every config settles `{0, 0}`, so
     * "the total is zero" is true of a match that pays nothing at all, and a
     * regression making Match Play never settle would have passed. That is why
     * the control also asserts money actually moved, and why the figures quoted
     * below are measured against a loosened schema rather than reasoned about.
     */
    const settled = (round: Round) => {
      const log = new EventLog()
      log.scoreByHole(round, { A: [4, 5, 3], B: [5, 4, 4] }, [1, 2, 3])
      log.append({ type: 'round/completed' })
      return deriveRound(round, log.events)
    }

    /**
     * An EMPTY side posts no score, so it loses every hole and the match
     * closes — and the settlement credits the winners while `sides[loser].map`
     * debits nobody. Verified against the loosened schema: this exact config
     * pays `{p-a: +500, p-b: +500}`, a thousand cents out of nothing.
     *
     * TWO players against nobody, deliberately. A lone player against an empty
     * side hits `sideStake`'s outnumbered branch and multiplies by the other
     * side's size — zero — so a 1v0 settles nothing and would make the figure
     * above unreproducible.
     *
     * BOTH SIDES, because the rule is `a.length > 0 && b.length > 0` and
     * dropping either conjunct is a separate way to reopen this. One case
     * leaves the other half of the rule unguarded.
     */
    it('refuses a side with nobody on it', () => {
      expect(settled(twoSided({ a: ['p-a', 'p-b'], b: [] })).derivations.has('game-1')).toBe(false)
      expect(settled(twoSided({ a: [], b: ['p-a', 'p-b'] })).derivations.has('game-1')).toBe(false)
    })

    /**
     * A DUPLICATED id is counted twice and paid once: the lone opponent is
     * debited `stake × 2` while the side's two entries collapse to a single key
     * in `Object.fromEntries`. Verified against the loosened schema: this pays
     * `{p-a: +500, p-b: -1000}`, five hundred cents short.
     */
    it('refuses a player booked onto a side twice', () => {
      const { derivations } = settled(twoSided({ a: ['p-a', 'p-a'], b: ['p-b'] }))
      expect(derivations.has('game-1')).toBe(false)
    })

    /**
     * This one moves no money — a player is their own opponent, so every hole
     * halves and the match pushes. Refused anyway: it is the same broken input,
     * and a schema that admitted it would be relying on the settlement to stay
     * accidentally balanced.
     */
    it('refuses a player on both sides at once', () => {
      const { derivations } = settled(twoSided({ a: ['p-a'], b: ['p-a'] }))
      expect(derivations.has('game-1')).toBe(false)
    })

    // …while the shape setup actually produces still derives, and balances
    it('still settles a well-formed 1v1', () => {
      const { derivations } = settled(twoSided({ a: ['p-a'], b: ['p-b'] }))
      const cents = Object.values(derivations.get('game-1')!.settlement.perPlayerCents)
      expect(cents.some((c) => c !== 0)).toBe(true)
      expect(cents.reduce((a, b) => a + b, 0)).toBe(0)
    })

    /**
     * THE ONE THAT SURVIVES THE SCHEMA CHANGING, and the reason it is here
     * rather than in the engine's own fixtures.
     *
     * Every guard above asserts a game is REFUSED, so all of them are really
     * assertions about `teamsSchema`. The engine's settlement is still built on
     * the assumption that the sides it is handed are non-empty and disjoint —
     * `sides[loseSide].map` debits nobody when a side is empty, and
     * `Object.fromEntries` collapses a duplicated id to one credit while the
     * opponent is charged for two. Match Play's own `meta` comment openly
     * contemplates relaxing the partition rule so two of a foursome can play
     * while the others sit out. Whoever does that will loosen the schema, watch
     * these three tests turn red, adjust them, and reopen the hole with nothing
     * left standing between a hand-edited round file and money out of nothing.
     *
     * So state the invariant instead of the gate: whatever sides a game arrives
     * carrying, it either does not settle or it settles to zero. True today via
     * the refusals, and still true — still checked — the day the refusals go.
     */
    it('any team shape either settles zero-sum or does not settle at all', () => {
      const SHAPES = [
        { a: ['p-a'], b: ['p-b'] },
        { a: ['p-a', 'p-b'], b: [] },
        { a: [], b: ['p-a', 'p-b'] },
        { a: [], b: [] },
        { a: ['p-a', 'p-a'], b: ['p-b'] },
        { a: ['p-a'], b: ['p-b', 'p-b'] },
        { a: ['p-a'], b: ['p-a'] },
        { a: ['p-a', 'p-b'], b: ['p-a'] },
        { a: ['p-ghost'], b: ['p-b'] },
      ]
      for (const teams of SHAPES) {
        const d = settled(twoSided(teams)).derivations.get('game-1')
        if (!d) continue // refused outright — the defence we have today
        const cents = Object.values(d.settlement.perPlayerCents)
        expect(
          cents.reduce((a, b) => a + b, 0),
          JSON.stringify(teams),
        ).toBe(0)
      }
    })
  })

  it('settles the good games in a round that also holds a broken one', () => {
    const round = withGames([
      { gameId: 'game-1', type: 'skins', config: {} },
      {
        gameId: 'game-2',
        type: 'skins',
        handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
        config: { stakeCents: 100, carryover: true },
      },
    ])
    const { derivations } = scored(round)
    expect(derivations.has('game-1')).toBe(false)
    const good = derivations.get('game-2')!
    const cents = Object.values(good.settlement.perPlayerCents)
    expect(cents.every((c) => Number.isFinite(c))).toBe(true)
    expect(cents.reduce((a, b) => a + b, 0)).toBe(0)
  })
})
