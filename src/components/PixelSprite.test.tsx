import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CELEBRATION_SPRITES } from '../engine/core/celebration'
import { PixelSprite, spriteGrid } from './PixelSprite'

/**
 * THE ANIMATION AND THE HANDLE MUST BE ON THE SAME ELEMENT.
 *
 * `index.css` freezes sprites under `prefers-reduced-motion` with
 * `[data-sprite] { animation: none !important }`. `animation` does not inherit,
 * so if the attribute sits one element above the animated one the rule matches
 * a node with nothing to stop — and every sprite keeps playing for a user who
 * asked the OS for stillness, while the CSS, the component comment and
 * CLAUDE.md all read as though it were handled.
 *
 * jsdom cannot evaluate a media query against a real user preference, so this
 * pins the structural half instead: the thing the rule selects is the thing
 * carrying the animation. That is exactly where the bug was.
 */
describe('PixelSprite', () => {
  it('puts the animation on the element the reduced-motion rule selects', () => {
    const { container } = render(<PixelSprite name="coin" />)
    const target = container.querySelector<HTMLElement>('[data-sprite="coin"]')
    expect(target).not.toBeNull()
    expect(target!.style.animationName).toBe('sprite-strip')
  })

  /**
   * A ONE-SHOT COMES TO REST ON ITS LAST FRAME. Travelling the full frame count
   * parks the strip one cell past the art and leaves an empty box on screen —
   * invisible in every test that only asks whether a sprite mounted.
   */
  it('holds the final frame when it plays once, and wraps when it loops', () => {
    // A CELL IS THE SPRITE'S OWN GRID times the scale, not 16 times it — the
    // logo is drawn at 32, so scale 4 is a 128px cell. Deriving it here rather
    // than writing 512 is the point: the arithmetic under test is steps-and-
    // travel, and a literal would have to be re-guessed every time a sprite is
    // redrawn at a different fidelity.
    const cell = spriteGrid('logo') * 4

    const once = render(<PixelSprite name="logo" scale={4} />)
    const onceSvg = once.container.querySelector<HTMLElement>('[data-sprite]')!
    // logo has 5 frames: 4 steps, travelling 4 cells
    expect(onceSvg.style.animationTimingFunction).toBe('steps(4)')
    expect(onceSvg.style.getPropertyValue('--sprite-travel')).toBe(`${-4 * cell}px`)
    expect(onceSvg.style.animationIterationCount).toBe('1')

    const loop = render(<PixelSprite name="logo" scale={4} loop />)
    const loopSvg = loop.container.querySelector<HTMLElement>('[data-sprite]')!
    // looping shows all 5 and wraps, so it travels the whole strip
    expect(loopSvg.style.animationTimingFunction).toBe('steps(5)')
    expect(loopSvg.style.getPropertyValue('--sprite-travel')).toBe(`${-5 * cell}px`)
    expect(loopSvg.style.animationIterationCount).toBe('infinite')
  })

  /**
   * Decorative by default: a celebration's meaning is carried by the words
   * beside it, and a screen reader announcing both says it twice.
   */
  it('is decorative unless given a label', () => {
    const { container } = render(<PixelSprite name="coin" />)
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(container.querySelector('[role="img"]')).toBeNull()

    const labelled = render(<PixelSprite name="coin" label="a coin" />)
    expect(labelled.container.querySelector('[role="img"]')).not.toBeNull()
  })

  /**
   * BLIND WOLF HAS TO LOOK DIFFERENT, and that is the entire difference between
   * these two sprites: one wolf, one swing, shades or no shades. The frames are
   * GENERATED from a shared character map (`wolfArt.tsx`) rather than drawn
   * twice, so a broken substitution — the eye/bridge characters resolving the
   * same way for both — would render two identical strips while every other
   * test passed and the engine went on correctly naming two different tokens.
   * The lone hole and the blind hole would simply celebrate the same way.
   */
  it('draws the blind wolf differently from the lone one', () => {
    const art = (name: 'wolf' | 'wolf-shades') =>
      render(<PixelSprite name={name} />).container.querySelector('[data-sprite]')!.innerHTML
    expect(art('wolf')).not.toBe(art('wolf-shades'))
  })

  /**
   * EVERY CELEBRATION FRAME HAS SOMETHING IN IT. `CelebrationsHaveArt` in the
   * component is a TYPE check: it proves a token maps to a frame list, not that
   * the list draws anything. An empty strip, or one frame of it that a legend
   * typo silently emptied, compiles and renders a blank box on the one screen
   * nobody writes a test for.
   */
  it('gives every celebration sprite something to draw in every frame', () => {
    for (const name of CELEBRATION_SPRITES) {
      const { container } = render(<PixelSprite name={name} />)
      const frames = container.querySelectorAll('[data-sprite] > g')
      expect(frames.length, `${name} has no frames`).toBeGreaterThan(1)
      frames.forEach((frame, i) => {
        expect(frame.querySelectorAll('rect').length, `${name} frame ${i} is blank`).toBeGreaterThan(0)
      })
    }
  })

  /**
   * A FRACTIONAL SCALE IS THE ONE WAY TO BREAK THE IDIOM SILENTLY. Crisp rects
   * snap to device pixels, and at 2.5 they snap to DIFFERENT widths across the
   * sprite — the coin comes out with one flat side. Nothing about it throws or
   * logs; it just renders a slightly wrong picture, which is exactly the class
   * of defect nobody files. `docs/pixel-art.md` states the rule; this is the
   * choke point that keeps it true.
   */
  it('refuses a fractional scale rather than rendering a lopsided sprite', () => {
    const { container } = render(<PixelSprite name="coin-small" scale={2.5} />)
    const box = container.querySelector<HTMLElement>('[data-sprite]')!.parentElement!
    // 16-grid at a rounded 3, never 16 × 2.5 = 40
    expect(box.style.width).toBe('48px')
  })
})
