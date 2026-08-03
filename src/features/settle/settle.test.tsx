import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { EventLog, makePlayers, makeRound } from '../../engine/test/harness'
import { db } from '../../db/schema'
import { buildExport, importRound } from './exportRound'

// jsdom has no canvas 2D context, so the painter can't run here — the model it
// paints is covered in summaryCard.test.ts. What's under test is the plumbing.
const paintMock = vi.hoisted(() =>
  vi.fn(async () => new Blob(['\x89PNG'], { type: 'image/png' })),
)
const shareMocks = vi.hoisted(() => ({
  canShare: vi.fn(() => true),
  download: vi.fn(),
  share: vi.fn(async (): Promise<'shared' | 'cancelled' | 'failed'> => 'shared'),
}))

vi.mock('./paintSummaryCard', () => ({ paintSummaryCard: paintMock }))
vi.mock('./shareImage', async (importOriginal) => ({
  // roundFileBase stays real — the filename is part of what's asserted
  ...(await importOriginal<typeof import('./shareImage')>()),
  canShareFile: () => shareMocks.canShare(),
  downloadFile: shareMocks.download,
  shareFile: shareMocks.share,
}))

const { routes } = await import('../../app/routes')

// jsdom implements neither of these
URL.createObjectURL = vi.fn(() => 'blob:mock-url')
URL.revokeObjectURL = vi.fn()

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
    expect(screen.getByText(/collects/)).toBeInTheDocument()
    expect(screen.getAllByText('+$1').length).toBeGreaterThan(0)
  })
})

describe('sharing the summary image', () => {
  beforeEach(() => {
    paintMock.mockClear()
    shareMocks.canShare.mockClear().mockReturnValue(true)
    shareMocks.download.mockClear()
    shareMocks.share.mockClear().mockResolvedValue('shared')
  })

  async function openShareSheet() {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Alice' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = `round-share-${Math.random().toString(36).slice(2)}`
    round.status = 'completed'
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: [3, 4], Alice: [4, 4] }, [1, 2])
    await db.rounds.put(round)
    await db.round_events.bulkAdd(log.events)

    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}/settle`] })
    render(<RouterProvider router={router} />)
    const trigger = await screen.findByRole('button', { name: 'Share' })
    await userEvent.click(trigger)
    return screen.findByAltText('Round summary')
  }

  it('replaces the JSON export with a share button', async () => {
    await openShareSheet()
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument()
    expect(paintMock).toHaveBeenCalledTimes(1)
  })

  it('offers only the OS share sheet where files can be shared', async () => {
    await openShareSheet()
    // the trigger plus the one inside the sheet
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(2)
    // no download button: the OS sheet's own "Save Image" is the save path, and
    // a browser download would put the PNG in Files rather than Photos
    expect(screen.queryByRole('button', { name: 'Save image' })).not.toBeInTheDocument()
  })

  it('falls back to a download only where files cannot be shared', async () => {
    shareMocks.canShare.mockReturnValue(false)
    await openShareSheet()
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(1) // the trigger
    expect(screen.getByRole('button', { name: 'Save image' })).toBeInTheDocument()
  })

  it('saves a PNG named after the course and date', async () => {
    shareMocks.canShare.mockReturnValue(false)
    await openShareSheet()
    await userEvent.click(screen.getByRole('button', { name: 'Save image' }))
    expect(shareMocks.download).toHaveBeenCalledTimes(1)
    const file = shareMocks.download.mock.calls[0]![0] as File
    expect(file.name).toBe('golf-Test-National-2026-07-18.png')
    expect(file.type).toBe('image/png')
  })

  it('falls back to a download when the share sheet fails', async () => {
    shareMocks.share.mockResolvedValue('failed')
    await openShareSheet()
    const [, sheetShare] = screen.getAllByRole('button', { name: 'Share' })
    await userEvent.click(sheetShare!)
    await waitFor(() => expect(shareMocks.download).toHaveBeenCalledTimes(1))
  })

  it('says so when the image cannot be built', async () => {
    paintMock.mockRejectedValueOnce(new Error('no canvas'))
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Alice' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = 'round-share-error'
    round.status = 'completed'
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: [3, 4], Alice: [4, 4] }, [1, 2])
    await db.rounds.put(round)
    await db.round_events.bulkAdd(log.events)

    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}/settle`] })
    render(<RouterProvider router={router} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }))

    expect(await screen.findByText(/Couldn't build the image/)).toBeInTheDocument()
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
