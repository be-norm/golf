import type { Course } from '../../engine/core/types'

/**
 * Where a card number physically is, when the round is a nine played twice
 * around (`doubleNine` stamps it into the snapshot). Undefined on an ordinary
 * course — and deliberately only consulted for display: the scorecard columns,
 * the money ledger and the event log all stay on the card's own 1–18 numbering.
 */
export function holeLoop(course: Course, hole: number): { hole: number; nth: number } | undefined {
  return course.holes.find((h) => h.number === hole)?.loop
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd". */
export function ordinal(n: number): string {
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}
