/**
 * The house open/closed mark: a chosen game's card in setup, and the pinned
 * bar's fold on the scoring screen.
 *
 * ▶ ROTATED, rather than a second glyph: the pixel display font has no ▾/▸ and
 * paints them as invisible specks, while ▶ is already proven here (HoleArrow,
 * "Rules ▶"). One component so that reason lives in one place — this is exactly
 * the kind of thing a later reader "tidies" into a chevron that renders as
 * nothing.
 *
 * Decorative: `aria-expanded` on the button already announces the state.
 *
 * It started scoped to setup, and MAI-104's fold is the third consumer that
 * comment anticipated — so it moved here rather than being imported across
 * features. `CourseSearch` still reaches a different answer for the same problem
 * (↓/↑ in a body-font row); unifying that one is still not this ticket.
 */
export function DisclosureArrow({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`font-display inline-block text-[10px] text-felt-400 transition-transform ${
        open ? 'rotate-90' : ''
      }`}
    >
      ▶
    </span>
  )
}
