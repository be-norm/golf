import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { PixelSprite } from './PixelSprite'

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
    const once = render(<PixelSprite name="logo" scale={4} />)
    const onceSvg = once.container.querySelector<HTMLElement>('[data-sprite]')!
    // logo has 5 frames: 4 steps, travelling 4 cells of 64px
    expect(onceSvg.style.animationTimingFunction).toBe('steps(4)')
    expect(onceSvg.style.getPropertyValue('--sprite-travel')).toBe('-256px')
    expect(onceSvg.style.animationIterationCount).toBe('1')

    const loop = render(<PixelSprite name="logo" scale={4} loop />)
    const loopSvg = loop.container.querySelector<HTMLElement>('[data-sprite]')!
    // looping shows all 5 and wraps, so it travels the whole strip
    expect(loopSvg.style.animationTimingFunction).toBe('steps(5)')
    expect(loopSvg.style.getPropertyValue('--sprite-travel')).toBe('-320px')
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
})
