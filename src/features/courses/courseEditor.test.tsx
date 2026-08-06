import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Course } from '../../engine/core/types'
import { db } from '../../db/schema'
import { LOCAL_USER, ORPHANED_AUTHOR } from '../../db/ids'
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

/**
 * The MAI-78 decision: editing a card you OWN updates it in place; anyone
 * else's silently forks. This predicate had zero coverage on the first two
 * attempts, and its regression mode is invisible (an in-place push onto a row
 * RLS refuses dies silently in the outbox) — so the whole flow is pinned
 * here, through the real editor. The tests run as a guest, whose identity is
 * LOCAL_USER like any other.
 */
describe('CourseEditorScreen — fork vs update in place (MAI-78)', () => {
  const V7_ID = '11111111-2222-7333-8444-555555555555'

  function card(id: string, overrides: Partial<Course> = {}): Course {
    return {
      id,
      name: 'Broadmoor Country Club',
      location: 'Indianapolis, IN',
      holeCount: 9,
      holes: [4, 4, 3, 4, 3, 4, 4, 4, 3].map((par, i) => ({
        number: i + 1,
        par,
        strokeIndex: i + 1,
      })),
      teeSets: [{ id: 'blue', name: 'Blue', rating: 35.1, slope: 103 }],
      source: 'user',
      updatedAt: '2026-08-01T00:00:00.000Z',
      revision: 1,
      ...overrides,
    }
  }

  async function editAndSave(id: string) {
    const router = createMemoryRouter(routes, { initialEntries: [`/courses/${id}/edit`] })
    render(<RouterProvider router={router} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Save course' }))
  }

  async function seed(c: Course) {
    await db.courses.put(c)
    await db.saved_courses.put({ userId: LOCAL_USER, courseId: c.id, updatedAt: c.updatedAt })
  }

  beforeEach(async () => {
    await Promise.all([db.courses.clear(), db.saved_courses.clear(), db.outbox.clear()])
  })

  it('your own card updates in place — same id, no fork, no notice', async () => {
    // legacy-authored: source user, no createdBy, locally-minted (v7) id
    await seed(card(V7_ID, { createdBy: undefined }))
    await editAndSave(V7_ID)

    await waitFor(async () => {
      expect((await db.courses.get(V7_ID))?.revision).toBe(2)
    })
    expect(await db.courses.count()).toBe(1)
    expect((await db.courses.get(V7_ID))?.createdBy).toBe(LOCAL_USER)
    expect(screen.queryByText(/Saved as your version/)).not.toBeInTheDocument()
  })

  it("another golfer's card forks: new id, membership moves, notice states it", async () => {
    await seed(card('lib-import', { createdBy: 'another-golfer-uid' }))
    await editAndSave('lib-import')

    // the fork replaced the original in this library, atomically
    await waitFor(async () => {
      expect(await db.saved_courses.get([LOCAL_USER, 'lib-import'])).toBeUndefined()
    })
    const all = await db.courses.toArray()
    expect(all).toHaveLength(1)
    const fork = all[0]!
    expect(fork.id).not.toBe('lib-import')
    expect(fork.createdBy).toBe(LOCAL_USER)
    expect(fork.sourceId).toBe('lib-import') // ODbL/derivation provenance
    expect(fork.revision).toBe(1) // a new course, not revision N+1 of theirs
    expect(await db.saved_courses.get([LOCAL_USER, fork.id])).toBeDefined()
    // the after-the-fact statement on the list screen — never a modal
    expect(await screen.findByText(/Saved as your version of/)).toBeInTheDocument()
  })

  it('an API import edited before createdBy existed still forks (provider id)', async () => {
    // main's editor rewrote every edited card to source:'user' — a gca: id
    // proves it wasn't authored here, and an in-place push would die against
    // RLS on the shared row (review finding on attempt two)
    await seed(card('gca:9', { createdBy: undefined }))
    await editAndSave('gca:9')

    await waitFor(async () => {
      expect(await db.saved_courses.get([LOCAL_USER, 'gca:9'])).toBeUndefined()
    })
    const fork = (await db.courses.toArray())[0]!
    expect(fork.id).not.toBe('gca:9')
    expect(fork.sourceId).toBe('gca:9')
  })

  it("an orphaned author's card (account deleted) forks too", async () => {
    await seed(card('lib-orphan', { createdBy: ORPHANED_AUTHOR }))
    await editAndSave('lib-orphan')

    await waitFor(async () => {
      expect(await db.saved_courses.get([LOCAL_USER, 'lib-orphan'])).toBeUndefined()
    })
    expect((await db.courses.toArray())[0]!.id).not.toBe('lib-orphan')
  })
})
