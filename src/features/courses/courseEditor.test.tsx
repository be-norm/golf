import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Course } from '../../engine/core/types'
import { routes } from '../../app/routes'

/** A 9-hole course pre-filled into the editor (the path a scorecard scan takes),
 *  par 33, one tee carrying the course's 18-HOLE rating by mistake. */
function misratedNine(rating: number): Course {
  return {
    id: 'edit-nine',
    name: 'Penmar',
    location: 'Venice, CA',
    holeCount: 9,
    holes: [4, 4, 3, 4, 3, 4, 4, 4, 3].map((par, i) => ({
      number: i + 1,
      par,
      strokeIndex: i + 1,
    })),
    teeSets: [{ id: 'blue', name: 'Blue', rating, slope: 103 }],
    source: 'user',
    updatedAt: '',
    revision: 0,
  }
}

/** The editor reads a pre-filled draft off router state (how ScanButton hands
 *  one in). Render at /courses/new with that state. */
function renderEditor(draft: Course) {
  const router = createMemoryRouter(routes, {
    initialEntries: [{ pathname: '/courses/new', state: { draft } }],
  })
  render(<RouterProvider router={router} />)
}

describe('CourseEditorScreen — 18-hole rating on a nine', () => {
  it('blocks save and flags the tee', async () => {
    renderEditor(misratedNine(63.4)) // 30 over par 33 → an 18-hole number

    expect(await screen.findByText(/looks like an 18-hole rating/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()
  })

  it('allows save once the rating is plausible for a nine', async () => {
    renderEditor(misratedNine(35.6)) // within a few strokes of par → fine

    expect(await screen.findByRole('button', { name: 'Save course' })).toBeEnabled()
    expect(screen.queryByText(/looks like an 18-hole rating/)).not.toBeInTheDocument()
  })
})
