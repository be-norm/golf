import { describe, expect, it } from 'vitest'
import './games/index'
import { deriveRound, listEngines } from './catalog'
import { EventLog, makePlayers, makeRound } from './test/harness'

const FAMILIES = ['match', 'stroke', 'points', 'pot', 'award', 'wager']
const CATEGORIES = ['main', 'side', 'either']
const SHAPES = ['solo', 'headToHead', 'teams', 'partners']

describe('engine registry invariants', () => {
  it('every game ships complete player-facing rules', () => {
    const engines = listEngines()
    expect(engines.length).toBeGreaterThanOrEqual(4)
    for (const engine of engines) {
      const { rules } = engine.meta
      expect(rules.tagline.length, `${engine.type} tagline`).toBeGreaterThan(0)
      expect(rules.howToPlay.length, `${engine.type} howToPlay`).toBeGreaterThan(0)
      expect(rules.scoring.length, `${engine.type} scoring`).toBeGreaterThan(0)
      expect(rules.terms.length, `${engine.type} terms`).toBeGreaterThan(0)
      for (const t of rules.terms) {
        expect(t.term.length, `${engine.type} term name`).toBeGreaterThan(0)
        expect(t.def.length, `${engine.type} "${t.term}" definition`).toBeGreaterThan(0)
      }
    }
  })

  /**
   * The taxonomy is what setup grouping, the picker sheet and display density
   * read. A game that omits it doesn't fail loudly — it quietly lands in
   * whatever bucket the renderer falls back to, which is how a side bet ends up
   * presented as somebody's main event (MAI-43).
   */
  it('every game declares where it belongs', () => {
    for (const engine of listEngines()) {
      expect(CATEGORIES, `${engine.type} category`).toContain(engine.meta.category)
      expect(FAMILIES, `${engine.type} family`).toContain(engine.meta.family)
      expect(engine.meta.shapes.length, `${engine.type} shapes`).toBeGreaterThan(0)
      for (const shape of engine.meta.shapes) {
        expect(SHAPES, `${engine.type} shape`).toContain(shape)
      }
    }
  })

  /**
   * A game that can be played solo AND in teams says so, but a game claiming
   * `teams` or `partners` must be able to seat them: two players cannot form
   * two sides, and a rotating-partner game needs at least three.
   */
  it('declares no shape its player limits cannot seat', () => {
    for (const engine of listEngines()) {
      const { shapes, minPlayers, maxPlayers } = engine.meta
      if (shapes.includes('teams') || shapes.includes('partners')) {
        expect(maxPlayers, `${engine.type} needs room for sides`).toBeGreaterThanOrEqual(3)
      }
      if (shapes.includes('headToHead')) {
        expect(minPlayers, `${engine.type} head-to-head needs 2`).toBeLessThanOrEqual(2)
      }
    }
  })
})

/**
 * THE ONE-WAY RULE, as a test rather than a paragraph.
 *
 * `role` is presentation: it says whether this round treats the game as its
 * main event or a side bet. Money must not notice. If it ever did, the same
 * scorecard would settle differently depending on how the group had grouped
 * their games on the setup screen — and the bug would be invisible, because
 * both answers are internally consistent and zero-sum.
 */
describe('taxonomy never reaches the money', () => {
  const scored = (role?: 'main' | 'side') => {
    const round = makeRound({
      players: makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }]),
      holes: 'front9',
      games: [
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: true } },
      ],
    })
    // stamped after construction so both rounds are otherwise byte-identical
    const games = round.games.map((g) => ({ ...g, ...(role ? { role } : {}) }))
    const log = new EventLog()
    log.scoreByHole(round, {
      A: [4, 5, 3, 4, 6, 4, 3, 5, 4],
      B: [5, 4, 4, 4, 5, 5, 3, 4, 5],
      C: [4, 6, 4, 3, 5, 4, 4, 6, 4],
    })
    return deriveRound({ ...round, games }, log.events)
  }

  it('settles a round identically whether its games are main, side, or unlabelled', () => {
    const asMain = [...scored('main').derivations.values()].map((d) => d.settlement)
    const asSide = [...scored('side').derivations.values()].map((d) => d.settlement)
    // absent is what every round created before MAI-43 looks like
    const absent = [...scored().derivations.values()].map((d) => d.settlement)

    expect(asSide).toEqual(asMain)
    expect(absent).toEqual(asMain)
    // and it actually moved money, or the assertion above is vacuous
    expect(asMain.some((s) => s.lines.length > 0)).toBe(true)
  })
})
