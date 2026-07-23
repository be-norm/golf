import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import type { Course } from '../../engine/core/types'
import { db } from '../../db/schema'
import { routes } from '../../app/routes'

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

/** Step 0: land on setup and pick Penmar (which auto-selects its only tee). */
async function pickPenmar() {
  await db.courses.put(penmar)
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

  it('resets the hole range when switching from a nine to an eighteen', async () => {
    await db.courses.bulkPut([penmar, eighteen])
    const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
    render(<RouterProvider router={router} />)

    // pick the nine (defaults to its 9-hole range), then switch to the eighteen
    await userEvent.click(await screen.findByText('Penmar Golf Course'))
    await userEvent.click(screen.getByText('Wood Wind'))
    await cont() // course → players

    // the eighteen must default to the full round, not inherit the nine's front9
    await addPlayer('Bogey', 10.4)
    await addPlayer('Scratch', 0)
    await cont() // players → games
    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    // (other tests in this file also tee off, so key on this round's course)
    const forEighteen = async () =>
      (await db.rounds.toArray()).find((r) => r.courseId === 'eighteen')
    await waitFor(async () => expect(await forEighteen()).toBeDefined())
    expect((await forEighteen())!.holes).toBe('full18')
  })

  it('halves the strokes when only the front 9 of an 18-hole course is played', async () => {
    await db.courses.put(eighteen)
    const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
    render(<RouterProvider router={router} />)

    await userEvent.click(await screen.findByText('Wood Wind'))
    // an 18-hole course, cut to the front 9
    await userEvent.click(screen.getByRole('button', { name: 'Front 9' }))
    expect(screen.getByText(/plays off half their course handicap/)).toBeInTheDocument()

    await cont() // course → players
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
