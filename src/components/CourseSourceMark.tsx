import type { Course } from '../engine/core/types'

/**
 * Says where a course card came from, everywhere courses are listed (MAI-77).
 *
 * The same course can exist twice — the API's row and one a golfer entered or
 * scanned (a fork, MAI-78) — and they used to render as two identical lines.
 * When one of them is the accurate card, picking blind means starting a round
 * on the wrong scorecard.
 *
 * The wording is VISIBLE text, not a bare glyph with a `title`: touch screens
 * have no hover, so meaning parked in title/aria never reaches a sighted phone
 * user (a review finding on the first attempt at this mark). The aria-label
 * carries the full phrasing for screen readers, so the distinction isn't
 * conveyed by colour or glyph alone.
 */
export function CourseSourceMark({ source }: { source: Course['source'] | undefined }) {
  const user = source === 'user'
  return (
    <span
      role="img"
      aria-label={user ? 'added by a golfer' : 'from a course directory'}
      className={`font-display ml-2 whitespace-nowrap align-middle text-[9px] uppercase ${
        user ? 'text-coin-400' : 'text-stone-500'
      }`}
    >
      {user ? '✎ golfer' : '⛳ api'}
    </span>
  )
}
