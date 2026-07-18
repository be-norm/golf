import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { makePlayers, makeRound } from '../../engine/test/harness'
import { db } from '../../db/schema'
import { eventStore } from '../../db/eventStore'
import { routes } from '../../app/routes'

describe('ScoringScreen', () => {
  it('confirms par with one tap and shows it on the chip', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Alice' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    await db.rounds.put(round)

    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    // hole header renders (hole 1, par 4)
    await screen.findByText('Hole')
    expect(await screen.findByText('Par 4 · SI 5')).toBeInTheDocument()

    // one tap on Ben's chip confirms par
    const chip = await screen.findByRole('button', { name: 'Ben score' })
    await userEvent.click(chip)

    const events = await eventStore.list(round.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'score/set', playerId: 'p-ben', hole: 1, gross: 4 })
  })

  it('undo retracts the last event', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Cal' }, { name: 'Dee' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = 'round-undo'
    await db.rounds.put(round)

    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    const chip = await screen.findByRole('button', { name: 'Cal score' })
    await userEvent.click(chip)
    await userEvent.click(await screen.findByRole('button', { name: 'undo' }))

    const events = await eventStore.list(round.id)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'meta/retract', targetEventId: events[0]!.id })
  })
})
