import { describe, expect, it } from 'vitest'
import type { GameDerivation } from '../engine/catalog'
import type { Round, Uuid } from '../engine/core/types'
import { roundStandings } from './standings'

const players = [
  { playerId: 'p-ann' as Uuid, name: 'Ann', courseHandicap: 0 },
  { playerId: 'p-bob' as Uuid, name: 'Bob', courseHandicap: 0 },
  { playerId: 'p-cat' as Uuid, name: 'Cat', courseHandicap: 0 },
] as unknown as Round['players']

/** Only the settlement is read, so the rest of a derivation is beside the point. */
const settled = (perPlayerCents: Record<string, number>) =>
  ({ settlement: { perPlayerCents, lines: [] } }) as unknown as GameDerivation

describe('roundStandings', () => {
  it('adds every bet together, richest first', () => {
    const rows = roundStandings(players, [
      settled({ 'p-ann': 500, 'p-bob': -500, 'p-cat': 0 }),
      settled({ 'p-ann': -200, 'p-bob': -100, 'p-cat': 300 }),
    ])

    expect(rows.map((r) => [r.name, r.cents])).toEqual([
      ['Ann', 300],
      ['Cat', 300],
      ['Bob', -600],
    ])
  })

  /**
   * BEING SQUARE IS A POSITION. The settle screen's payout list drops zeroes
   * because a payment of nothing is not a payment; a standings view is the
   * opposite — a player who has won and lost the same amount is level, and a
   * roster that grows and shrinks as money moves is harder to read than one
   * that doesn't.
   */
  it('keeps a player sitting on zero', () => {
    const rows = roundStandings(players, [settled({ 'p-ann': 500, 'p-bob': -500, 'p-cat': 0 })])

    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.name === 'Cat')?.cents).toBe(0)
  })

  it('is zero-sum, so the column always adds to nothing', () => {
    const rows = roundStandings(players, [
      settled({ 'p-ann': 500, 'p-bob': -500, 'p-cat': 0 }),
      settled({ 'p-ann': -200, 'p-bob': -100, 'p-cat': 300 }),
    ])

    expect(rows.reduce((a, r) => a + r.cents, 0)).toBe(0)
  })

  /** Exactly one, and only when they are actually up — not "least behind". */
  it('marks the leader only when somebody is ahead', () => {
    const up = roundStandings(players, [settled({ 'p-ann': 500, 'p-bob': -500, 'p-cat': 0 })])
    expect(up.filter((r) => r.leader).map((r) => r.name)).toEqual(['Ann'])

    const nobodyUp = roundStandings(players, [settled({ 'p-ann': 0, 'p-bob': 0, 'p-cat': 0 })])
    expect(nobodyUp.filter((r) => r.leader)).toHaveLength(0)
  })

  it('reports everyone level when no bet has moved', () => {
    const rows = roundStandings(players, [])

    expect(rows.map((r) => r.cents)).toEqual([0, 0, 0])
  })

  /**
   * A settlement naming somebody outside the round contributes nothing, rather
   * than inventing a row for them — `combineSettlements` seeds its keys from
   * the roster and skips the rest.
   */
  it('ignores a settlement naming a player who is not in the round', () => {
    const rows = roundStandings(players, [
      settled({ 'p-ann': 500, 'p-bob': -500, 'p-ghost': 9999 }),
    ])

    expect(rows.map((r) => r.name)).toEqual(['Ann', 'Cat', 'Bob'])
    expect(rows.reduce((a, r) => a + r.cents, 0)).toBe(0)
  })
})
