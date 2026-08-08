import { describe, expect, it } from 'vitest'
import '../games'
import { skinsEngine, type SkinsConfig } from '../games/skins/engine'
import { makePlayers } from '../test/harness'
import type { GameConfig, HandicapSettings } from './types'
import { duplicateInstanceProblems } from './setup'

/**
 * Setup can hold two instances of one game (MAI-44) — which is the point, and
 * also the first way a user can shoot themselves in the foot on this screen.
 */

const net: HandicapSettings = { mode: 'net', allowancePct: 100, reference: 'offLow' }
const gross: HandicapSettings = { mode: 'gross', allowancePct: 100, reference: 'absolute' }

const skins = (gameId: string, config: unknown, handicap = net): GameConfig => ({
  gameId,
  type: 'skins',
  handicap,
  config,
})

const DUP = 'Two Skins games have identical settings — change one or remove it'

describe('duplicateInstanceProblems', () => {
  it('catches two instances that differ in nothing', () => {
    const a = skins('g1', { stakeCents: 100, carryover: true })
    const b = skins('g2', { stakeCents: 100, carryover: true })
    expect(duplicateInstanceProblems(a, [b], 'Skins')).toEqual([DUP])
    // BOTH report it — neither one is "the duplicate", so the caller dedupes
    expect(duplicateInstanceProblems(b, [a], 'Skins')).toEqual([DUP])
  })

  /**
   * The round `gameLabel`'s discriminator ladder exists for. Gross skins beside
   * net skins is a real thing people play, and a check keyed on type alone
   * would have made this screen refuse it.
   */
  it('leaves gross-beside-net alone — the handicap IS a difference', () => {
    const a = skins('g1', { stakeCents: 100, carryover: true }, net)
    const b = skins('g2', { stakeCents: 100, carryover: true }, gross)
    expect(duplicateInstanceProblems(a, [b], 'Skins')).toEqual([])
  })

  it('leaves two instances differing by a single cent alone', () => {
    const a = skins('g1', { stakeCents: 100, carryover: true })
    const b = skins('g2', { stakeCents: 101, carryover: true })
    expect(duplicateInstanceProblems(a, [b], 'Skins')).toEqual([])
  })

  it('ignores siblings of a different type that happen to match', () => {
    const a = skins('g1', { stakeCents: 100 })
    const other: GameConfig = { gameId: 'g2', type: 'wolf', handicap: net, config: { stakeCents: 100 } }
    expect(duplicateInstanceProblems(a, [other], 'Skins')).toEqual([])
  })

  it('compares by VALUE, not by key order', () => {
    const a = skins('g1', { stakeCents: 100, carryover: true })
    const b = skins('g2', { carryover: true, stakeCents: 100 })
    expect(duplicateInstanceProblems(a, [b], 'Skins')).toEqual([DUP])
  })

  /**
   * Arrays keep their order, deliberately: Wolf's `rotation` is a running
   * order, so two Wolf games differing only in who goes first are two games.
   * Sorting arrays into the canonical form would have called them one.
   */
  it('treats a different array order as a different game', () => {
    const a: GameConfig = { gameId: 'g1', type: 'wolf', handicap: net, config: { rotation: ['a', 'b'] } }
    const b: GameConfig = { gameId: 'g2', type: 'wolf', handicap: net, config: { rotation: ['b', 'a'] } }
    expect(duplicateInstanceProblems(a, [b], 'Wolf')).toEqual([])
  })

  it('says nothing when there are no siblings at all', () => {
    expect(duplicateInstanceProblems(skins('g1', { stakeCents: 100 }), [], 'Skins')).toEqual([])
  })
})

describe('validateSetup reaches it', () => {
  const players = makePlayers([{ name: 'Ann' }, { name: 'Ben' }])
  const cfg = (gameId: string): GameConfig<SkinsConfig> => ({
    gameId,
    type: 'skins',
    handicap: net,
    config: { stakeCents: 100, carryover: true },
  })

  it('reports a duplicate through the engine, alongside its own checks', () => {
    expect(skinsEngine.validateSetup(cfg('g1'), players, [cfg('g2')])).toEqual([DUP])
  })

  it('stays silent for a single instance', () => {
    expect(skinsEngine.validateSetup(cfg('g1'), players, [])).toEqual([])
  })
})
