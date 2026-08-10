/**
 * The open/closed mark on a chosen game's card.
 *
 * ▶ ROTATED, rather than a second glyph: the pixel display font has no ▾/▸ and
 * paints them as invisible specks, while ▶ is already proven here (HoleArrow,
 * "Rules ▶"). One component for the two cards so that reason lives in one place
 * — this is exactly the kind of thing a later reader "tidies" into a chevron
 * that renders as nothing.
 *
 * Decorative: `aria-expanded` on the button already announces the state.
 *
 * Deliberately scoped to setup rather than made a `components/` primitive.
 * `CourseSearch` reached a different answer for the same problem (↓/↑ in a
 * body-font row) and unifying the two is not this ticket.
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
