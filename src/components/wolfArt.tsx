import type { ReactElement } from 'react'

/**
 * ONE WOLF, DRAWN ONCE — the head `PixelGlyph` renders still and `PixelSprite`
 * animates. Both are 16×16 `shape-rendering="crispEdges"` rects on the integer
 * grid, in the idiom `public/icon.svg` set; the only difference between them is
 * that one of them moves.
 *
 * It lives here because the alternative was two copies of a twenty-rect animal.
 * They would agree on the day they were written and drift on the first day
 * somebody re-shaped an ear — and the failure is silent, because nothing
 * renders the glyph and the sprite side by side.
 *
 * `wolfHead` KEEPS ITS ORIGINAL SIGNATURE, taking eyes and nothing else. The
 * sprite needs an open jaw, and the obvious move — a second `mouth` slot — would
 * have changed the glyph's render path to serve the sprite. `PixelGlyph` has no
 * test of its own, so that change would have been caught by nothing but `tsc`.
 * SVG paints in document order instead: a frame draws the head and then paints
 * its jaw OVER the chin, and the still picture cannot move.
 */

export const FUR = '#a8a29e'
export const FUR_DARK = '#57534e'
export const MUZZLE = '#d6d3d1'
export const INK = '#1c1917'
export const EYE = '#ffd23e'
export const LENS = '#0c0a09'
export const GLINT = '#f5f5f4'

/** The head every variant shares — ears, taper, muzzle. Eyes are the variable. */
export function wolfHead(eyes: ReactElement) {
  return (
    <>
      {/* ear tips */}
      <rect x="2" y="1" width="2" height="1" fill={FUR} />
      <rect x="12" y="1" width="2" height="1" fill={FUR} />
      <rect x="1" y="2" width="4" height="1" fill={FUR} />
      <rect x="11" y="2" width="4" height="1" fill={FUR} />
      <rect x="1" y="3" width="5" height="1" fill={FUR} />
      <rect x="10" y="3" width="5" height="1" fill={FUR} />
      {/* inner ear */}
      <rect x="2" y="2" width="2" height="2" fill={FUR_DARK} />
      <rect x="12" y="2" width="2" height="2" fill={FUR_DARK} />
      {/* skull, then the taper down to the snout */}
      <rect x="1" y="4" width="14" height="4" fill={FUR} />
      <rect x="2" y="8" width="12" height="2" fill={FUR} />
      <rect x="3" y="10" width="10" height="1" fill={FUR} />
      <rect x="4" y="11" width="8" height="1" fill={FUR} />
      <rect x="5" y="12" width="6" height="1" fill={FUR} />
      <rect x="6" y="13" width="4" height="1" fill={FUR} />
      {eyes}
      {/* muzzle + nose */}
      <rect x="6" y="11" width="4" height="2" fill={MUZZLE} />
      <rect x="7" y="12" width="2" height="1" fill={INK} />
    </>
  )
}

export const WOLF_EYES = (
  <>
    <rect x="4" y="6" width="2" height="2" fill={EYE} />
    <rect x="10" y="6" width="2" height="2" fill={EYE} />
  </>
)

/**
 * Two lenses JOINED BY A BRIDGE, with the temple arms reaching for the ears.
 * The connection is what makes it read as one object worn on the face rather
 * than as dark eyes — and the lenses stay INSET, with fur on all four sides.
 * A band spanning the full head width was the first attempt, and since the
 * lens colour is near the page's, it cut the head in half: ears floating
 * above a muzzle.
 *
 * `glintAt` is the sprite's one degree of freedom: the highlight sits on the
 * left pixel of each lens at rest, and sliding it right is how the shades catch
 * the light while the wolf howls. The still glyph passes nothing and gets the
 * drawing it always had.
 */
export function shadesEyes(glintAt = 0): ReactElement {
  return (
    <>
      <rect x="3" y="6" width="4" height="2" fill={LENS} />
      <rect x="9" y="6" width="4" height="2" fill={LENS} />
      <rect x="7" y="6" width="2" height="1" fill={LENS} />
      <rect x="2" y="6" width="1" height="1" fill={LENS} />
      <rect x="13" y="6" width="1" height="1" fill={LENS} />
      <rect x={3 + glintAt} y="6" width="1" height="1" fill={GLINT} />
      <rect x={9 + glintAt} y="6" width="1" height="1" fill={GLINT} />
    </>
  )
}

export const SHADES_EYES = shadesEyes()
