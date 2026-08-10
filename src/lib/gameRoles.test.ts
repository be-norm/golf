import { describe, expect, it } from 'vitest'
import '../engine/games'
import type { GameConfig, Round } from '../engine/core/types'
import { makePlayers, makeRound } from '../engine/test/harness'
import { partitionByRole, primaryGame, shouldGroupSideBets, strokeGame } from './gameRoles'

/**
 * The one rule three surfaces used to answer three different ways: the scoring
 * screen's stroke dots took the first NET game of any role, the scorecard took
 * `games[0]`, and the share card took the first net game or nothing (MAI-50).
 */

const net = { mode: 'net', allowancePct: 100, reference: 'offLow' } as const
const gross = { mode: 'gross', allowancePct: 100, reference: 'absolute' } as const

/** A round holding exactly these games, in this order. */
function round(games: { type: string; handicap: typeof net | typeof gross }[]): Round {
  const built = makeRound({
    players: makePlayers([{ name: 'Ann' }, { name: 'Ben' }, { name: 'Cal' }, { name: 'Dee' }]),
    holes: 'front9',
    games: games.map((g) => ({ type: g.type, config: {}, handicap: g.handicap })),
  })
  return built
}

describe('primaryGame', () => {
  it('prefers a net MAIN game over a gross one, whatever the order', () => {
    const r = round([
      { type: 'nassau', handicap: gross },
      { type: 'vegas', handicap: net },
    ])
    expect(primaryGame(r)!.type).toBe('vegas')
  })

  /**
   * The bug this rule exists for. A cheap net side bet used to capture the
   * scoring screen's stroke display purely by being net — the old rule was
   * "first game with mode: net" and never asked what role it played.
   */
  it('does NOT let a net side bet outrank a gross main game', () => {
    // skins is category 'either'; beside a nassau it is the side bet
    const r = round([
      { type: 'nassau', handicap: gross },
      { type: 'skins', handicap: net },
    ])
    expect(primaryGame(r)!.type).toBe('nassau')
    // and nothing claims a stroke, because the main game allocates none
    expect(strokeGame(r)).toBeUndefined()
  })

  it('falls back to the first main game when no main game is net', () => {
    const r = round([
      { type: 'skins', handicap: net },
      { type: 'nassau', handicap: gross },
    ])
    expect(primaryGame(r)!.type).toBe('nassau')
  })

  it('falls back to games[0] when every game is a side bet', () => {
    // two "either" games: roleOf makes the FIRST one main, so this also pins
    // that the fallback and roleOf agree rather than fighting
    const r = round([
      { type: 'skins', handicap: gross },
      { type: 'skins', handicap: net },
    ])
    expect(primaryGame(r)).toBe(r.games[0])
  })

  it('is undefined for a round carrying no games at all', () => {
    expect(primaryGame(round([]))).toBeUndefined()
    expect(strokeGame(round([]))).toBeUndefined()
  })
})

describe('strokeGame', () => {
  /**
   * A round of nothing but side bets falls through to `games[0]`, so a CTP that
   * arrived NET — an import, a hand-edited log, a round written before the game
   * declared itself — would draw stroke dots on the scorecard and print
   * "underline = handicap stroke: Closest to the Pin" onto the share card, for
   * an allocation the engine never reads. Setup no longer offers the choice;
   * this is what covers the rounds that already made it.
   */
  it('never names a game strokes cannot decide, even stored as net', () => {
    const net = { mode: 'net' as const, allowancePct: 100, reference: 'offLow' as const }
    const ctp: GameConfig = { gameId: 'g1', type: 'ctp', handicap: net, config: {} }
    const r = { games: [ctp] } as unknown as Round
    expect(primaryGame(r)).toBe(ctp)
    expect(strokeGame(r)).toBeUndefined()
  })


  it('is the primary game when it allocates strokes', () => {
    const r = round([{ type: 'nassau', handicap: net }])
    expect(strokeGame(r)).toBe(r.games[0])
  })

  /**
   * Undefined rather than "the primary game anyway": the share card renders
   * this as prose — "underline = handicap stroke: Skins" — so naming a gross
   * game would caption underlines that were never drawn.
   */
  it('is undefined when the primary game is gross', () => {
    expect(strokeGame(round([{ type: 'nassau', handicap: gross }]))).toBeUndefined()
  })
})

describe('partitionByRole', () => {
  it('splits by roleOf and keeps round order within each half', () => {
    const r = round([
      { type: 'skins', handicap: net },
      { type: 'nassau', handicap: net },
      { type: 'skins', handicap: gross },
    ])
    const { main, side } = partitionByRole(r.games)
    // nassau can only be a main event, so both skins are side bets
    expect(main.map((g) => g.type)).toEqual(['nassau'])
    expect(side.map((g) => g.gameId)).toEqual([r.games[0]!.gameId, r.games[2]!.gameId])
  })

  it('makes a lone "either" game the main event', () => {
    const r = round([{ type: 'skins', handicap: net }])
    expect(partitionByRole(r.games).main).toHaveLength(1)
    expect(partitionByRole(r.games).side).toHaveLength(0)
  })
})

describe('shouldGroupSideBets', () => {
  it('groups only when it saves a row', () => {
    // the common two-game round: collapsing costs the bar its hole recap and
    // saves nothing, so it stays expanded
    expect(shouldGroupSideBets({ main: 1, side: 1 })).toBe(false)
    expect(shouldGroupSideBets({ main: 1, side: 2 })).toBe(true)
    expect(shouldGroupSideBets({ main: 1, side: 7 })).toBe(true)
  })

  it('never groups a round that is only side bets', () => {
    // nothing to collapse them under — one row reading "SIDE BETS" for the
    // whole round says nothing
    expect(shouldGroupSideBets({ main: 0, side: 3 })).toBe(false)
  })
})

/** Guards the vitest include: this file must actually be picked up by a project. */
describe('module wiring', () => {
  it('reads a real GameConfig shape', () => {
    const game: GameConfig = round([{ type: 'skins', handicap: net }]).games[0]!
    expect(game.gameId).toBeTruthy()
  })
})
