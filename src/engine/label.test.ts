import { describe, expect, it } from 'vitest'
import './games/index'
import { gameLabel } from './label'
import type { GameConfig, HandicapSettings } from './core/types'

const net: HandicapSettings = { mode: 'net', allowancePct: 100, reference: 'offLow' }
const gross: HandicapSettings = { mode: 'gross', allowancePct: 100, reference: 'absolute' }

const skins = (gameId: string, handicap: HandicapSettings, stakeCents = 100): GameConfig => ({
  gameId,
  type: 'skins',
  handicap,
  config: { stakeCents, carryover: true },
})

describe('gameLabel', () => {
  it('uses the engine name, not a transform of the type', () => {
    const sixPoint: GameConfig = {
      gameId: 'g1',
      type: 'sixPoint',
      handicap: net,
      config: { pointCents: 25 },
    }
    // the bug this replaces: "SixPoint" in the bar, "sixPoint" on the scorecard
    expect(gameLabel(sixPoint, [sixPoint])).toBe('Six Point')
  })

  it('leaves a lone game plainly named', () => {
    const one = skins('g1', net)
    const nassau: GameConfig = {
      gameId: 'g2',
      type: 'nassau',
      handicap: net,
      config: { stakeCents: 500, teams: null, autoPress: true },
    }
    // a round with other games in it, just not another Skins
    expect(gameLabel(one, [one, nassau])).toBe('Skins')
    expect(gameLabel(nassau, [one, nassau])).toBe('Nassau')
  })

  it('separates gross skins from net skins — the case that motivated it', () => {
    const a = skins('g1', net)
    const b = skins('g2', gross)
    expect(gameLabel(a, [a, b])).toBe('Skins · net')
    expect(gameLabel(b, [a, b])).toBe('Skins · gross')
  })

  it('falls to allowance, then stake, for siblings alike in handicap mode', () => {
    const a = skins('g1', net)
    const b = skins('g2', { ...net, allowancePct: 90 })
    expect(gameLabel(a, [a, b])).toBe('Skins · 100%')
    expect(gameLabel(b, [a, b])).toBe('Skins · 90%')

    const cheap = skins('g1', net, 100)
    const dear = skins('g2', net, 500)
    expect(gameLabel(cheap, [cheap, dear])).toBe('Skins · $1')
    expect(gameLabel(dear, [cheap, dear])).toBe('Skins · $5')
  })

  /**
   * Two bets identical in every nameable way. Numbering them is still better
   * than two rows both reading "Skins" — the player at least knows there are
   * two, which is the whole job of the label.
   */
  it('numbers siblings that are alike in every way we can name', () => {
    const a = skins('g1', net)
    const b = skins('g2', net)
    expect(gameLabel(a, [a, b])).toBe('Skins · #1')
    expect(gameLabel(b, [a, b])).toBe('Skins · #2')
  })

  it('falls back to the raw type for an engine that is not registered', () => {
    const orphan: GameConfig = { gameId: 'g1', type: 'notAGame', handicap: net, config: {} }
    // an imported round naming a game this build doesn't ship
    expect(gameLabel(orphan, [orphan])).toBe('notAGame')
  })
})
