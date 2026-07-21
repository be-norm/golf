import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { makePlayers, makeRound } from '../../engine/test/harness'
import { db } from '../../db/schema'
import { routes } from '../../app/routes'

function renderStart(roundId: string) {
  const router = createMemoryRouter(routes, { initialEntries: [`/round/${roundId}/start`] })
  render(<RouterProvider router={router} />)
}

describe('RoundStartScreen', () => {
  it('shows each player their per-game stroke count at 80% before scoring', async () => {
    // Scratch vs CH 18 at 80% off-low: applyAllowance(18,80)=14 → high plays 14,
    // scratch plays 0. No score events — allocation is score-independent.
    const round = makeRound({
      players: makePlayers([{ name: 'Scratch', ch: 0 }, { name: 'Bogey', ch: 18 }]),
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: true },
          handicap: { mode: 'net', allowancePct: 80, reference: 'offLow' },
        },
      ],
    })
    round.id = 'round-start-net'
    await db.rounds.put(round)

    renderStart(round.id)

    expect(await screen.findByText('★ First tee ★')).toBeInTheDocument()
    expect(await screen.findByText(/Net · 80% · off the low/)).toBeInTheDocument()
    // Bogey gets 14, the scratch player 0.
    const bogey = (await screen.findByText('Bogey')).closest('li')!
    expect(bogey).toHaveTextContent('CH 18 · 14 strokes')
    const scratch = (await screen.findByText('Scratch')).closest('li')!
    expect(scratch).toHaveTextContent('CH 0 · 0 strokes')
    // config summary is surfaced
    expect(screen.getByText(/Skin value \$1/)).toBeInTheDocument()
  })

  it('shows no strokes for a gross game', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann', ch: 5 }, { name: 'Bo', ch: 12 }]),
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: false },
          handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
        },
      ],
    })
    round.id = 'round-start-gross'
    await db.rounds.put(round)

    renderStart(round.id)

    expect(await screen.findByText('Gross — no strokes')).toBeInTheDocument()
    // no per-player stroke rows (those carry a "CH n · " prefix); names listed instead
    expect(screen.queryByText(/CH \d+ ·/)).not.toBeInTheDocument()
    expect(screen.getByText('Ann · Bo')).toBeInTheDocument()
  })
})
