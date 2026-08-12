import { describe, expect, it } from 'vitest'
import committedIcon from '../../docs/assets/course-icon.svg?raw'
import { courseIconSvg } from './courseArt'

/**
 * ONE PICTURE, THREE PLACES — and they have drifted before. The PNG icon set
 * was redrawn and neither `public/icon.svg` nor the in-app sprite followed, so
 * the mark on your home screen and the mark at the top of the app were two
 * different logos for months.
 *
 * The two this repo can hold together, it now holds together: the published SVG
 * is GENERATED from the frames the app animates. A comment asking the next
 * person to change both was the previous arrangement, and it is the one that
 * failed.
 *
 * (The PNG/ICO set is painted by hand at each size and cannot be generated from
 * this — see `docs/pixel-art.md`. That seam is real, and it is why the browser
 * tab keeps the hand-painted `.ico` rather than this.)
 */
describe('courseArt', () => {
  it('keeps public/icon.svg identical to the drawing the app animates', () => {
    expect(
      committedIcon,
      'docs/assets/course-icon.svg is stale — paste the generated string below over it',
    ).toBe(courseIconSvg())
  })
})
