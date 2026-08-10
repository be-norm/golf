import { describe, expect, it } from 'vitest'
import {
  addLine,
  collectorsFrom,
  combineSettlements,
  formatCents,
  minimalTransfers,
  type Settlement,
} from './money'

const settlement = (perPlayerCents: Record<string, number>): Settlement => ({
  perPlayerCents,
  lines: [],
})

describe('formatCents', () => {
  it('formats whole dollars without decimals', () => {
    expect(formatCents(500)).toBe('$5')
    expect(formatCents(0)).toBe('$0')
  })

  it('formats cents with two digits', () => {
    expect(formatCents(1250)).toBe('$12.50')
    expect(formatCents(5)).toBe('$0.05')
  })

  it('formats negatives', () => {
    expect(formatCents(-325)).toBe('-$3.25')
  })
})

describe('combineSettlements', () => {
  it('sums every game into one balance and stays zero-sum', () => {
    const combined = combineSettlements(
      ['a', 'b', 'c'],
      [settlement({ a: 300, b: -100, c: -200 }), settlement({ a: -50, b: 150, c: -100 })],
    )
    expect(combined).toEqual({ a: 250, b: 50, c: -300 })
    expect(Object.values(combined).reduce((x, y) => x + y, 0)).toBe(0)
  })

  it('keeps players who never won or lost anything, at zero', () => {
    // the full roster has to survive into standings, not just the movers
    expect(combineSettlements(['a', 'b'], [settlement({})])).toEqual({ a: 0, b: 0 })
  })

  it('is empty-safe', () => {
    expect(combineSettlements([], [])).toEqual({})
  })
})

describe('collectorsFrom', () => {
  it('groups debtors under each creditor, biggest collector first', () => {
    const collectors = collectorsFrom([
      { fromPlayerId: 'x', toPlayerId: 'a', cents: 100 },
      { fromPlayerId: 'y', toPlayerId: 'b', cents: 500 },
      { fromPlayerId: 'z', toPlayerId: 'a', cents: 250 },
    ])
    expect(collectors).toEqual([
      { toPlayerId: 'b', totalCents: 500, from: [{ fromPlayerId: 'y', cents: 500 }] },
      {
        toPlayerId: 'a',
        totalCents: 350,
        from: [
          { fromPlayerId: 'x', cents: 100 },
          { fromPlayerId: 'z', cents: 250 },
        ],
      },
    ])
  })

  it('is empty when nobody owes anybody', () => {
    expect(collectorsFrom(minimalTransfers({ a: 0, b: 0 }))).toEqual([])
  })

  it('collector totals reconcile with the balances they came from', () => {
    const combined = combineSettlements(
      ['a', 'b', 'c'],
      [settlement({ a: 425, b: -125, c: -300 })],
    )
    for (const c of collectorsFrom(minimalTransfers(combined))) {
      expect(c.totalCents).toBe(combined[c.toPlayerId])
      expect(c.from.reduce((sum, f) => sum + f.cents, 0)).toBe(c.totalCents)
    }
  })
})

/**
 * `addLine` is the choke point for the two things `settlement.lines` promises:
 * every row names players in this round, and every row moved money. Both are
 * refusals rather than throws — `deriveRound` has no try/catch, and a malformed
 * import must not white-screen a round the user can still open.
 */
describe('addLine', () => {
  const fresh = (): Settlement => ({ perPlayerCents: { 'p-a': 0, 'p-b': 0 }, lines: [] })

  it('accrues a line that moves money', () => {
    const s = fresh()
    addLine(s, { label: 'A wins', perPlayerCents: { 'p-a': 100, 'p-b': -100 } })
    expect(s.lines).toHaveLength(1)
    expect(s.perPlayerCents).toEqual({ 'p-a': 100, 'p-b': -100 })
  })

  it('refuses a line naming somebody outside the round', () => {
    const s = fresh()
    addLine(s, { label: 'ghost', perPlayerCents: { 'p-a': 100, 'p-nobody': -100 } })
    expect(s.lines).toHaveLength(0)
    expect(s.perPlayerCents).toEqual({ 'p-a': 0, 'p-b': 0 })
  })

  /**
   * A ONE-PLAYER ROUND makes `stake * (players - 1)` zero for every engine at
   * once — refused by every `validateSetup`, accepted by `importRound`, which
   * validates a roster with `.min(1)`. Skins would push one empty row per hole,
   * the award kit one per awarded hole, Snake one at the end, and
   * `lines.length === 0` — the settle panel's "No money moved." signal — would
   * be false on a round where nothing moved (MAI-40).
   */
  it('refuses a line that moves nothing', () => {
    const s = fresh()
    addLine(s, { label: 'nothing happened', perPlayerCents: { 'p-a': 0, 'p-b': 0 } })
    expect(s.lines).toHaveLength(0)

    const solo: Settlement = { perPlayerCents: { 'p-a': 0 }, lines: [] }
    addLine(solo, { label: 'A collects from nobody', perPlayerCents: { 'p-a': 0 } })
    expect(solo.lines).toHaveLength(0)
  })
})
