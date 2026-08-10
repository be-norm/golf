import { describe, expect, it } from 'vitest'
import './games/index'
import { deriveRound, listEngines } from './catalog'
import { EventLog, makePlayers, makeRound, TEST_ONLY_ENGINE_TYPES } from './test/harness'

describe('scratch2', () => {
  it('holeSummary on an unplayed hole, every engine', () => {
    for (const e of listEngines().filter((x) => !TEST_ONLY_ENGINE_TYPES.includes(x.type))) {
      const names = ['A', 'B', 'C', 'D'].slice(0, Math.max(e.meta.minPlayers, 4))
      const players = makePlayers(names.map((name, i) => ({ name, ch: i * 3 })))
      const round = makeRound({
        players, holes: 'front9',
        games: [{ type: e.type, config: e.defaultConfig(players), handicap: e.defaultHandicap() }],
      })
      const log = new EventLog()
      log.scoreByHole(round, Object.fromEntries(names.map((n) => [n, [4]])), [1])
      const d = deriveRound(round, log.events).derivations.get('game-1')!
      console.log(e.type, 'h1:', JSON.stringify(d.holeSummary(1)), 'h5(unplayed):', JSON.stringify(d.holeSummary(5)))
    }
    expect(true).toBe(true)
  })
})
