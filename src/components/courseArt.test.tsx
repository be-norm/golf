import { describe, expect, it } from 'vitest'
import committedIcon from '../../public/icon.svg?raw'
import { courseIconSvg } from './courseArt'

/**
 * ONE PICTURE, THREE PLACES — and they have drifted before. The PNG icon set
 * was redrawn and neither `public/icon.svg` nor the in-app sprite followed, so
 * the mark on your home screen and the mark at the top of the app were two
 * different logos for months.
 *
 * The two things this repo can hold together, it now holds together: the
 * favicon is GENERATED from the frames the app animates. A comment asking the
 * next person to change both was the previous arrangement, and it is the one
 * that failed.
 *
 * (The PNG set is painted by hand and cannot be generated from this — see
 * `docs/pixel-art.md`. That seam is real and is why this one is worth closing.)
 */
describe('courseArt', () => {
  it('keeps public/icon.svg identical to the drawing the app animates', () => {
    expect(
      committedIcon,
      'public/icon.svg is stale — paste the generated string below over it',
    ).toBe(courseIconSvg())
  })
})
