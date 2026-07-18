import { describe, expect, it } from 'vitest'
import { formatCents } from './money'

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
