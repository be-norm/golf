import type { Course } from '../engine/core/types'

/**
 * Says where a course card came from, in one glyph.
 *
 * The same course can exist twice — the API's row and one a golfer entered or
 * scanned — and they render as two identical lines. When one of them is the
 * accurate card, picking blind means starting a round on the wrong scorecard
 * (MAI-77).
 *
 * ✎ = somebody typed or scanned this: unverified, but often better, because a
 * golfer who plays there fixed it. ⛳ = it came from a course API.
 *
 * `title` + `aria-label` carry the meaning, so the distinction survives a
 * screen reader and isn't left to a glyph nobody has been taught.
 */
export function CourseSourceMark({ source }: { source: Course['source'] | undefined }) {
  const user = source === 'user'
  const label = user ? 'added by a golfer' : 'from a course directory'
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={`ml-1.5 shrink-0 text-xs ${user ? 'text-coin-400' : 'text-stone-500'}`}
    >
      {user ? '✎' : '⛳'}
    </span>
  )
}
