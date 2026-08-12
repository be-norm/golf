import { useEffect, useState } from 'react'
import { FRAME_MS } from '../lib/motion'
import { PixelSprite, scaleFor, spriteFrames } from './PixelSprite'

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
/**
 * How wide the banner is on screen, which is the number that matters: it has to
 * clear `max-w-md` — 532px against this app's 19px root — for the bleed to be a
 * bleed. A hardcoded scale is the very thing `scaleFor` exists to replace, and
 * would quietly stop clearing it the day the art is redrawn on another grid.
 */
const BANNER_PX = 540

/**
 * A REDUCED-MOTION VIEWER GETS NO CEREMONY. The strip freeze is CSS, which
 * cannot see a JS state swap — so without this they were shown frame 0 of the
 * approach (a ball hanging in the sky) for nine hundred milliseconds, and then
 * one uninvited picture change to a course with the ball already holed. Going
 * straight to the resting scene is both stiller and more honest.
 */
const stillPreferred = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

type Ceremony = 'logo' | 'flag-plant'

/**
 * KEYED ON THE CEREMONY, so a banner handed a new one starts it over instead of
 * skipping to the wind — React's own answer to "reset state when a prop
 * changes", and it keeps the timer effect free of the setState that resetting
 * by hand would need. No caller changes `intro` today (both pass a literal, and
 * a route change remounts), so this closes a trap rather than a bug.
 */
export function CourseBanner({ intro }: { intro: Ceremony }) {
  return <Phases key={intro} intro={intro} />
}

function Phases({ intro }: { intro: Ceremony }) {
  const [done, setDone] = useState(stillPreferred)
  // a one-shot travels n-1 frames, so that is what there is to wait out
  useEffect(() => {
    if (done) return
    // BUILD THE WIND'S ELEMENTS NOW, not in the swap render. `once()` builds on
    // first use, which left alone is inside the very re-render that mounts
    // them. This moves the CONSTRUCTION only — mounting the DOM still happens
    // at the handover and is the larger half; what made that affordable is the
    // shared backdrop, which took the strip from seven thousand nodes to two.
    spriteFrames('logo-idle')
    const t = setTimeout(() => setDone(true), (spriteFrames(intro) - 1) * FRAME_MS)
    return () => clearTimeout(t)
  }, [intro, done])

  return (
    <span className="-mx-4 flex justify-center overflow-hidden">
      <span className="shrink-0">
        {/* KEYED SO IT REMOUNTS. Without this React reconciles one `<svg>` in
            place: `animation-name` never changes, so per CSS Animations the
            running animation is not restarted — only its duration and step
            count are swapped underneath it. The wind then opens at whatever
            fraction the approach had reached, which is frame 4 of 8, and the
            gust jumps a hundred and forty pixels at the handover. Two commits
            went into matching frame 0 to the intro's last frame; none of it
            could show while the strip never started at frame 0. */}
        {done ? (
          <PixelSprite
            key="idle"
            name="logo-idle"
            scale={scaleFor('logo-idle', BANNER_PX)}
            frameMs={WIND_FRAME_MS}
            loop
          />
        ) : (
          <PixelSprite key={intro} name={intro} scale={scaleFor(intro, BANNER_PX)} />
        )}
      </span>
    </span>
  )
}
