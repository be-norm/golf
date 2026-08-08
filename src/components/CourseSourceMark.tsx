import type { Course } from '../engine/core/types'

/**
 * Says where a course card came from, everywhere courses are listed (MAI-77).
 *
 * The same course can exist several times — the directory's row and the
 * versions golfers entered or scanned (forks, MAI-78) — and they used to render
 * as identical lines. When one of them is the accurate card, picking blind
 * means starting a round on the wrong scorecard.
 *
 * Three states, because once search offers those versions side by side (MAI-79)
 * "which of these is mine?" is the first thing that decides the pick. The
 * WORDS differ, not just the colour — two shades of gold telling you which card
 * is yours would be exactly the colour-alone distinction the aria-label below
 * exists to avoid.
 *
 * The wording is VISIBLE text, not a bare glyph with a `title`: touch screens
 * have no hover, so meaning parked in title/aria never reaches a sighted phone
 * user (a review finding on the first attempt at this mark). The aria-label
 * carries the full phrasing for screen readers.
 */
export function CourseSourceMark({
  source,
  mine,
}: {
  source: Course['source'] | undefined
  mine?: boolean
}) {
  const user = source === 'user'
  const text = user ? (mine ? '✎ yours' : '✎ community') : '⛳ api'
  const label = user
    ? mine
      ? 'your own version'
      : 'added by a golfer in the community'
    : 'from a course directory'
  const tone = user ? (mine ? 'text-coin-400' : 'text-coin-500') : 'text-stone-500'
  return (
    <span
      role="img"
      aria-label={label}
      className={`font-display ml-2 whitespace-nowrap align-middle text-[9px] uppercase ${tone}`}
    >
      {text}
    </span>
  )
}
