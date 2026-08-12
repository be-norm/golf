import { useEffect, useState } from 'react'
import { FRAME_MS } from '../lib/motion'
import { PixelSprite, spriteFrames } from './PixelSprite'

/**
 * THE COURSE, ACROSS THE TOP OF A SCREEN: a ceremony that happens once, and
 * then weather that runs for as long as anybody is looking.
 *
 * Each screen brings its own ceremony and they share the aftermath — the home
 * screen holes an approach, the first tee plants the flag, and both settle into
 * the same wind. That split is the whole reason this is a component rather than
 * two sprites: a one-shot strip comes to rest on its final frame, which is a
 * photograph, and a looping one repeats its ceremony until the ball holing out
 * reads as a metronome rather than a shot.
 *
 * FULL WIDTH BY BLEEDING AND CROPPING, never by stretching — a fluid width is a
 * fractional scale, and crisp rects at a fractional scale snap to different
 * device-pixel widths across one picture (`docs/pixel-art.md`, rule 1). The
 * banner is drawn wider than the column, escapes the gutter and lets its ends
 * clip; what goes is fairway off one side and a rim of green off the other.
 *
 * CENTRED BY FLEX, NOT BY `mx-auto`, and that is not a style preference. When a
 * box is WIDER than its containing block, CSS resolves auto margins to zero —
 * so `mx-auto` silently left-aligns and every pixel of the overflow comes off
 * the RIGHT, which is the end the flag and the hole are on. On a 375px screen
 * that cropped them away entirely. Flex centring overflows both ends, which is
 * what "crops a little off each side" needs to be true. `shrink-0` because a
 * flex item would otherwise be squeezed to the container instead of overflowing
 * it, which lands in the same place by a third route.
 */

/** Slower than the house rate: a flap, not a flutter. */
const WIND_FRAME_MS = 200

export function CourseBanner({ intro }: { intro: 'logo' | 'flag-plant' }) {
  const [done, setDone] = useState(false)
  // a one-shot travels n-1 frames, so that is what there is to wait out
  useEffect(() => {
    const t = setTimeout(() => setDone(true), (spriteFrames(intro) - 1) * FRAME_MS)
    return () => clearTimeout(t)
  }, [intro])

  return (
    <span className="-mx-4 flex justify-center overflow-hidden">
      <span className="shrink-0">
        {done ? (
          <PixelSprite name="logo-idle" scale={4} frameMs={WIND_FRAME_MS} loop />
        ) : (
          <PixelSprite name={intro} scale={4} />
        )}
      </span>
    </span>
  )
}
