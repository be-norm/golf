/**
 * THE HOUSE EASING SIGNATURE: motion snaps to a grid, it does not ease on a
 * curve. Both CSS keyframes in `index.css` use `steps()` for the same reason —
 * choppiness is what reads as 8-bit, and a smooth cubic-bezier on pixel art
 * reads as a modern app wearing a costume.
 *
 * Quantizes a Motion ease function into `n` discrete jumps. Lower `n` is
 * chunkier: `stepped(3)` is a hard three-frame move, `stepped(12)` is nearly
 * smooth. Match `n` to the distance travelled — a 400px fall wants more steps
 * than a 40px nudge, or the jumps read as dropped frames rather than as style.
 *
 * Lived inline in three places before it lived here (`Sheet` at 5, the settle
 * standings at 3, `Confetti` parameterised), which is two too many for the one
 * decision that makes the app's motion look like itself.
 */
export const stepped =
  (n: number) =>
  (t: number): number =>
    Math.ceil(t * n) / n

/**
 * How long one sprite frame holds (`PixelSprite`). ~11fps — deliberately far
 * below the display's rate, because a sprite that updates every frame stops
 * reading as pixel art and starts reading as a video. The whole strip's
 * duration is this times its step count, so a longer animation comes from
 * drawing more frames rather than from slowing these down.
 */
export const FRAME_MS = 90
