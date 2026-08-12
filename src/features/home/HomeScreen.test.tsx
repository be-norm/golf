import 'fake-indexeddb/auto'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { routes } from '../../app/routes'

describe('HomeScreen', () => {
  it('renders the app name and new-round entry', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] })
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { name: 'Golf' })).toBeInTheDocument()
    expect(screen.getByText('New round')).toBeInTheDocument()
  })

  /**
   * THE BALL GOES IN ONCE. The approach is a one-shot strip and the wind is a
   * looping one, and the screen swaps between them — so what this pins is that
   * the swap HAPPENS. Leave it out and the mark comes to rest on its last frame
   * and stays there, a photograph of a holed putt for as long as anybody is on
   * the screen; loop the approach instead and the ball holes out every couple
   * of seconds, which stops reading as a shot and starts reading as a metronome.
   */
  it('plays the approach once, then leaves the course in the wind', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] })
    const { container } = render(<RouterProvider router={router} />)
    await screen.findByRole('heading', { name: 'Golf' })
    expect(container.querySelector('[data-sprite="logo"]')).not.toBeNull()
    expect(container.querySelector('[data-sprite="logo-idle"]')).toBeNull()

    // generously past the ~900ms swap: the default 1000ms left no margin, and
    // passed only because the re-render blocked the thread across a tick
    await waitFor(() => expect(container.querySelector('[data-sprite="logo-idle"]')).not.toBeNull(), {
      timeout: 4000,
    })
    // and the ball is not coming round again
    expect(container.querySelector('[data-sprite="logo"]')).toBeNull()
  })
})
