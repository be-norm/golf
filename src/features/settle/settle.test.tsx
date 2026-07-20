import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { EventLog, makePlayers, makeRound } from '../../engine/test/harness'
import { db } from '../../db/schema'
import { routes } from '../../app/routes'
import { buildExport, importRound } from './exportRound'

describe('SettleScreen', () => {
  it('shows combined standings and who pays whom', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Alice' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = 'round-settle'
    round.status = 'completed'
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: [3, 4], Alice: [4, 4] }, [1, 2])
    await db.rounds.put(round)
    await db.round_events.bulkAdd(log.events)

    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}/settle`] })
    render(<RouterProvider router={router} />)

    expect(await screen.findByText('Settle up')).toBeInTheDocument()
    expect(screen.getByText(/pays/)).toBeInTheDocument()
    expect(screen.getAllByText('+$1').length).toBeGreaterThan(0)
  })
})

describe('export/import round-trip', () => {
  it('re-imports an exported round with identical events', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'X' }, { name: 'Y' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = 'round-export'
    const log = new EventLog(round.id)
    log.scoreByHole(round, { X: [4, 5], Y: [5, 5] }, [1, 2])
    await db.rounds.put(round)
    await db.round_events.bulkAdd(log.events)

    const exported = await buildExport(round)
    await db.rounds.delete(round.id)
    await db.round_events.where('roundId').equals(round.id).delete()

    const imported = await importRound(JSON.stringify(exported), 'user-x')
    expect(imported.id).toBe(round.id)
    expect(imported.userId).toBe('user-x')
    const events = await db.round_events.where('roundId').equals(round.id).toArray()
    expect(events).toHaveLength(log.events.length)
  })
})
