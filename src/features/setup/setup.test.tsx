import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import type { Course } from '../../engine/core/types'
import { db } from '../../db/schema'
import { LOCAL_USER } from '../../db/ids'
import { routes } from '../../app/routes'

const SAVED_AT = '2026-08-01T00:00:00.000Z'

/**
 * fake-indexeddb is one store for the whole FILE, and several of these tests
 * tee off. Without this the rounds pile up and any test asserting "exactly one
 * round" fails depending on which of its neighbours got there first — a real
 * ~60%-of-runs flake when the file is run on its own.
 */
beforeEach(async () => {
  await Promise.all([
    db.rounds.clear(),
    db.courses.clear(),
    db.saved_courses.clear(),
    db.players.clear(),
    db.outbox.clear(),
  ])
})

/**
 * Penmar exactly as OpenGolfAPI serves it: 9 holes, par 33, slope 103, and NO
 * published course rating (so `rating` falls back to par and the (rating − par)
 * term drops out). This is the round that shipped 15 strokes to a 16.5 index.
 */
const penmar: Course = {
  id: 'penmar',
  name: 'Penmar Golf Course',
  location: 'Venice, CA',
  holeCount: 9,
  holes: [4, 4, 3, 4, 3, 4, 4, 4, 3].map((par, i) => ({
    number: i + 1,
    par,
    strokeIndex: [6, 2, 8, 4, 9, 1, 5, 3, 7][i]!,
  })),
  teeSets: [{ id: 'tee-0-blue', name: 'Blue', rating: 33, slope: 103 }],
  source: 'remote',
  updatedAt: '2026-07-22T00:00:00.000Z',
  revision: 0,
}

/** A plain 18-hole course, to check the hole range resets when courses switch. */
const eighteen: Course = {
  id: 'eighteen',
  name: 'Wood Wind',
  location: 'Westfield, IN',
  holeCount: 18,
  holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1 })),
  teeSets: [{ id: 'tee-white', name: 'White', rating: 70, slope: 120 }],
  source: 'remote',
  updatedAt: '2026-07-22T00:00:00.000Z',
  revision: 0,
}

/** Land on setup and pick Penmar. Picking a course auto-selects its first tee
 *  and moves to the tee/holes step, so this leaves us on step 1. */
async function pickPenmar() {
  await db.courses.put(penmar)
  // the picker lists the SIGNED-IN USER's library, so a seeded card needs
  // membership too — course data is shared, keeping it is owned (MAI-76)
  await db.saved_courses.put({ userId: LOCAL_USER, courseId: penmar.id, updatedAt: SAVED_AT })
  const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
  render(<RouterProvider router={router} />)
  await userEvent.click(await screen.findByText('Penmar Golf Course'))
}

/** Step 1: add a player and give them a handicap index. */
async function addPlayer(name: string, index: number) {
  await userEvent.type(screen.getByPlaceholderText('Player name'), name)
  await userEvent.click(screen.getByRole('button', { name: 'Add' }))
  fireEvent.change(await screen.findByLabelText(`${name} handicap index`), {
    target: { value: String(index) },
  })
}

const cont = () => userEvent.click(screen.getByRole('button', { name: 'Continue' }))

describe('SetupScreen — picking the course is its own step', () => {
  it('leaves the course list behind once a course is chosen', async () => {
    // Choosing tees underneath a list of every OTHER course read as though the
    // list were still the question being asked.
    await db.courses.bulkPut([penmar, eighteen])
    await db.saved_courses.bulkPut([
      { userId: LOCAL_USER, courseId: penmar.id, updatedAt: SAVED_AT },
      { userId: LOCAL_USER, courseId: eighteen.id, updatedAt: SAVED_AT },
    ])
    const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
    render(<RouterProvider router={router} />)

    // step 0 — every course, and no tees
    expect(await screen.findByText('Wood Wind')).toBeInTheDocument()
    expect(screen.queryByText('Tees')).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('Penmar Golf Course'))

    // step 1 — the chosen course, its tees, and none of the others
    expect(await screen.findByText('Tees')).toBeInTheDocument()
    expect(screen.getByText('Holes')).toBeInTheDocument()
    expect(screen.queryByText('Wood Wind')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Scan scorecard/i })).not.toBeInTheDocument()
    // and it says which course these tees belong to
    expect(screen.getByText('Penmar Golf Course')).toBeInTheDocument()
  })

  it('goes back to the course list to change your mind', async () => {
    await pickPenmar()
    expect(await screen.findByText('Tees')).toBeInTheDocument()

    await userEvent.click(screen.getByText('← Back'))

    expect(await screen.findByText('Where are you playing?')).toBeInTheDocument()
    expect(screen.queryByText('Tees')).not.toBeInTheDocument()
  })
})

describe('SetupScreen — 9-hole courses', () => {
  it('gives a nine HALF the index: 16.5 → HCP 8, not 15', async () => {
    await pickPenmar()
    // a 9-hole course defaults to its nine and says what that does to handicaps
    expect(screen.getByText(/half your index/)).toBeInTheDocument()

    await cont()
    await addPlayer('Bogey', 16.5)

    // (16.5 ÷ 2) × (103/113) + (33 − 33) = 7.52 → 8. The bug gave 15.
    expect(await screen.findByText('HCP 8')).toBeInTheDocument()
  })

  it('gives the FULL index when the nine is played twice around', async () => {
    await pickPenmar()
    await userEvent.click(screen.getByRole('button', { name: '18 (twice around)' }))
    expect(screen.getByText(/full 18-hole handicaps/)).toBeInTheDocument()

    await cont()
    await addPlayer('Bogey', 16.5)

    // two loops → rating 66 against par 66: 16.5 × (103/113) = 15.04 → 15
    expect(await screen.findByText('HCP 15')).toBeInTheDocument()
  })

  it('freezes a doubled 18-hole snapshot at tee-off, leaving the library course a nine', async () => {
    await pickPenmar()
    await userEvent.click(screen.getByRole('button', { name: '18 (twice around)' }))
    await cont()
    await addPlayer('Bogey', 16.5)
    await addPlayer('Scratch', 0)
    await cont()

    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    await waitFor(async () => expect(await db.rounds.count()).toBe(1))
    const round = (await db.rounds.toArray())[0]!
    expect(round.holes).toBe('full18')
    expect(round.courseSnapshot.holeCount).toBe(18)
    expect(round.courseSnapshot.holes).toHaveLength(18)
    // second loop replays the same holes, on the even stroke indexes
    expect(round.courseSnapshot.holes[14]!.par).toBe(round.courseSnapshot.holes[5]!.par)
    expect(round.courseSnapshot.holes[5]!.strokeIndex).toBe(1)
    expect(round.courseSnapshot.holes[14]!.strokeIndex).toBe(2)
    expect(round.players.find((p) => p.name === 'Bogey')!.courseHandicap).toBe(15)
    // the library course itself is untouched — still the nine it is
    expect(round.courseId).toBe('penmar')
    expect((await db.courses.get('penmar'))!.holeCount).toBe(9)
  })

  /**
   * Setup writes NO `role`. Whether an "either" game is this round's main event
   * or its side bet depends on what else is in the round, so a per-game guess
   * frozen here would be permanently wrong in a synced archive — `roleOf`
   * derives it instead (see catalog.test.ts for the rule itself).
   */
  it('leaves role unstamped, for roleOf to derive', async () => {
    await pickPenmar()
    await cont()
    await addPlayer('Bogey', 16.5)
    await addPlayer('Scratch', 0)
    await cont()

    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    await waitFor(async () => expect(await db.rounds.count()).toBe(1))
    const round = (await db.rounds.toArray())[0]!
    expect(round.games).toHaveLength(1)
    expect(round.games[0]!.role).toBeUndefined()
  })

  it('resets the hole range when switching from a nine to an eighteen', async () => {
    await db.courses.bulkPut([penmar, eighteen])
    await db.saved_courses.bulkPut([
      { userId: LOCAL_USER, courseId: penmar.id, updatedAt: SAVED_AT },
      { userId: LOCAL_USER, courseId: eighteen.id, updatedAt: SAVED_AT },
    ])
    const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
    render(<RouterProvider router={router} />)

    // pick the nine (defaults to its 9-hole range), then go back and switch to
    // the eighteen — changing your mind is what Back is for now that the course
    // list isn't sharing a screen with the tees
    await userEvent.click(await screen.findByText('Penmar Golf Course'))
    await userEvent.click(screen.getByText('← Back'))
    await userEvent.click(screen.getByText('Wood Wind'))
    await cont() // tees/holes → players

    // the eighteen must default to the full round, not inherit the nine's front9
    await addPlayer('Bogey', 10.4)
    await addPlayer('Scratch', 0)
    await cont() // players → games
    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    await waitFor(async () => expect(await db.rounds.count()).toBe(1))
    const round = (await db.rounds.toArray())[0]!
    expect(round.courseId).toBe('eighteen')
    expect(round.holes).toBe('full18')
  })

  it('halves the strokes when only the front 9 of an 18-hole course is played', async () => {
    await db.courses.put(eighteen)
    await db.saved_courses.put({ userId: LOCAL_USER, courseId: eighteen.id, updatedAt: SAVED_AT })
    const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
    render(<RouterProvider router={router} />)

    await userEvent.click(await screen.findByText('Wood Wind'))
    // an 18-hole course, cut to the front 9
    await userEvent.click(screen.getByRole('button', { name: 'Front 9' }))
    expect(screen.getByText(/plays off half their course handicap/)).toBeInTheDocument()

    await cont() // tees/holes → players
    // rating 70 / slope 120 / par 72: index 21 → CH round(20.30)=20 (the FULL
    // 18-hole handicap); index 2 → CH 0, the low.
    await addPlayer('Bogey', 21)
    await addPlayer('Scratch', 2)
    // the chip shows the full course handicap, not the per-round halving
    expect(await screen.findByText('HCP 20')).toBeInTheDocument()

    await cont() // players → games
    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    // First Tee: CH still reads 20, but only 9 holes are played, so the strokes
    // are halved — round(20/2)=10, spread over the front-nine stroke indexes.
    expect(await screen.findByText('★ First tee ★')).toBeInTheDocument()
    expect(strokeRow('Bogey')).toHaveTextContent('CH 20 · 10 strokes')
    expect(strokeRow('Scratch')).toHaveTextContent('CH 0 · 0 strokes')
  })
})

/** A player's per-GAME stroke row on the First Tee screen — the editable
 *  handicap list above it lists the same names, so match the row that reports
 *  strokes. (Mirrors the helper in roundStart.test.tsx.) */
function strokeRow(name: string): HTMLElement {
  const row = screen
    .getAllByText(name)
    .map((el) => el.closest('li'))
    .find((li) => li?.textContent?.includes('strokes'))
  if (!row) throw new Error(`no stroke row for ${name}`)
  return row
}
