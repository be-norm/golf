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
     * Scored AND FINISHED, unlike the rest of this file. A match only pays when
     * it is decided, so a three-hole prefix of a nine settles nothing whatever
     * its teams look like — a guard test written against one would pass on a
     * broken schema and prove precisely nothing. Completing the round finalizes
     * the remaining holes (halved, nobody posted) and closes the match.
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
     * side's size — zero — so 1v0 quietly pays nothing and would hide this.
     */
    it('refuses a side with nobody on it', () => {
      const { derivations } = settled(twoSided({ a: ['p-a', 'p-b'], b: [] }))
      expect(derivations.has('game-1')).toBe(false)
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
