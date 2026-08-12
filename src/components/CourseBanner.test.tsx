import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CourseBanner } from './CourseBanner'

/**
 * THE BANNER IS WIDER THAN ITS COLUMN ON PURPOSE, and how it is centred decides
 * whether that reads as "bleeds to both edges" or as "the right-hand third is
 * missing".
 *
 * CSS resolves `auto` margins to ZERO when a box is wider than its containing
 * block. So `mx-auto` — which is what this shipped with — silently left-aligns
 * it and puts every pixel of the overflow on the right, which is the end the
 * flag and the hole are on. On a 375px screen it cropped them away entirely.
 * Flex centring overflows both ends instead; `shrink-0` stops the item being
 * squeezed to fit, which would land in the same place by a third route.
 *
 * jsdom computes no layout, so this pins the mechanism rather than the pixels —
 * the same bargain `PixelSprite.test.tsx` strikes for the reduced-motion rule.
 */
describe('CourseBanner', () => {
  it('centres by overflowing both ends, not by auto margins', () => {
    const { container } = render(<CourseBanner intro="logo" />)
    const sprite = container.querySelector('[data-sprite]')!
    const bleed = container.firstElementChild as HTMLElement

    expect(bleed.className).toContain('justify-center')
    expect(bleed.className).toContain('overflow-hidden')
    expect(bleed.className).not.toContain('mx-auto')
    // and the picture itself must not be squeezed to the column
    expect(sprite.parentElement!.parentElement!.className).toContain('shrink-0')
  })
})
