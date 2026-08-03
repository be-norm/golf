import { describe, expect, it } from 'vitest'
import {
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
