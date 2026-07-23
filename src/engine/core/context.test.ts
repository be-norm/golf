import { describe, expect, it } from 'vitest'
import { buildRoundContext } from './context'
import { makeCourse, makePlayers, makeRound } from '../test/harness'
import type { Course, HandicapSettings } from './types'

/**
 * Handicap-allowance allocation, verified by hand. The default test course
 * carries unique 18-hole stroke indexes 1..18, so a player's stroke on a hole
 * is decided purely by that hole's SI rank vs. their playing handicap.
 *
 * Pipeline order (context.ts): courseHandicapForTee (9-hole courses halve the
 * INDEX there, before the round ever sees it) → applyAllowance(pct) →
 * 9-of-18 halving → off-low subtraction → allocateStrokes.
 */
const GAME = 'game-1'

function ctxFor(
  courseHandicaps: Record<string, number>,
  handicap: HandicapSettings,
  holes?: 'front9',
  course?: Course,
) {
  const players = makePlayers(
    Object.entries(courseHandicaps).map(([name, ch]) => ({ name, ch })),
  )
  const round = makeRound({ players, holes, course, games: [{ type: 'skins', config: {}, handicap }] })
  const ctx = buildRoundContext(round, [])
  const strokesTotal = (name: string) =>
    ctx.holesPlayed.reduce((s, h) => s + ctx.strokesFor(GAME, round.players.find((p) => p.name === name)!.playerId, h), 0)
  const strokesOn = (name: string, hole: number) =>
    ctx.strokesFor(GAME, round.players.find((p) => p.name === name)!.playerId, hole)
  return { strokesTotal, strokesOn }
}

describe('allowance % → stroke allocation', () => {
  it('100% off-low gives the full stroke spread', () => {
    // scratch vs 18: low = 0, so 18 plays off 18 → one stroke on every hole.
    const { strokesTotal } = ctxFor(
      { Scratch: 0, Bogey: 18 },
      { mode: 'net', allowancePct: 100, reference: 'offLow' },
    )
    expect(strokesTotal('Scratch')).toBe(0)
    expect(strokesTotal('Bogey')).toBe(18)
  })

  it('80% shrinks the spread and drops strokes off the easiest holes', () => {
    // applyAllowance(18, 80) = round(14.4) = 14 → strokes on the 14 hardest
    // holes (SI rank ≤ 14), none on the 4 easiest: SI 15 (hole 9),
    // SI 16 (hole 12), SI 17 (hole 5), SI 18 (hole 16).
    const { strokesTotal, strokesOn } = ctxFor(
      { Scratch: 0, Bogey: 18 },
      { mode: 'net', allowancePct: 80, reference: 'offLow' },
    )
    expect(strokesTotal('Bogey')).toBe(14)
    for (const h of [9, 12, 5, 16]) expect(strokesOn('Bogey', h)).toBe(0)
    for (const h of [3, 11, 6, 8]) expect(strokesOn('Bogey', h)).toBe(1) // SI 1..4
  })

  it('applies the allowance BEFORE the off-low subtraction', () => {
    // CH 3 & 16 at 80% reduce to round(2.4)=2 and round(12.8)=13.
    //   absolute → 2 and 13 strokes.
    //   off-low  → low is the reduced 2, so High plays 13-2 = 11.
    // These values DISTINGUISH the pipeline order: reducing first then
    // subtracting gives 11, whereas the wrong order (subtract 16-3=13, THEN
    // take 80% → round(10.4)=10) would give 10. Asserting 11 locks the order.
    const abs = ctxFor({ Low: 3, High: 16 }, { mode: 'net', allowancePct: 80, reference: 'absolute' })
    expect(abs.strokesTotal('Low')).toBe(2)
    expect(abs.strokesTotal('High')).toBe(13)

    const off = ctxFor({ Low: 3, High: 16 }, { mode: 'net', allowancePct: 80, reference: 'offLow' })
    expect(off.strokesTotal('Low')).toBe(0)
    expect(off.strokesTotal('High')).toBe(11)
  })

  it('halves an 18-hole course handicap AFTER the allowance when playing 9', () => {
    // front 9 of an 18-hole course: applyAllowance(20, 80)=16, then halved → 8.
    // At 100% it would be 20 → halved to 10. Shows allowance then halving.
    const eighty = ctxFor({ Scratch: 0, Bogey: 20 }, { mode: 'net', allowancePct: 80, reference: 'offLow' }, 'front9')
    expect(eighty.strokesTotal('Bogey')).toBe(8)
    const full = ctxFor({ Scratch: 0, Bogey: 20 }, { mode: 'net', allowancePct: 100, reference: 'offLow' }, 'front9')
    expect(full.strokesTotal('Bogey')).toBe(10)
  })

  it('does NOT halve again on a true 9-hole course', () => {
    // A nine's stored CH is already a 9-hole number — courseHandicapForTee
    // halved the INDEX against the nine's own rating/slope — so the engine
    // allocates it as-is. Halving here too (the 9-of-18 rule) would give 4.
    const nine = makeCourse([4, 4, 3, 4, 3, 4, 4, 4, 3], [6, 2, 8, 4, 9, 1, 5, 3, 7])
    const { strokesTotal, strokesOn } = ctxFor(
      { Scratch: 0, Mid: 8 },
      { mode: 'net', allowancePct: 100, reference: 'offLow' },
      'front9',
      nine,
    )
    expect(strokesTotal('Mid')).toBe(8)
    // one stroke on the 8 hardest; hole 5 (SI 9, the easiest) is the odd one out
    expect(strokesOn('Mid', 5)).toBe(0)
    expect(strokesOn('Mid', 6)).toBe(1) // SI 1
  })

  it('gross mode ignores the allowance entirely', () => {
    const { strokesTotal } = ctxFor(
      { Scratch: 0, Bogey: 18 },
      { mode: 'gross', allowancePct: 80, reference: 'offLow' },
    )
    expect(strokesTotal('Bogey')).toBe(0)
  })
})
