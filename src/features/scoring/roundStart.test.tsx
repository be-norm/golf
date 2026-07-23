import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { makePlayers, makeRound } from '../../engine/test/harness'
import { db } from '../../db/schema'
import { eventStore } from '../../db/eventStore'
import { routes } from '../../app/routes'

function renderStart(roundId: string) {
  const router = createMemoryRouter(routes, { initialEntries: [`/round/${roundId}/start`] })
  render(<RouterProvider router={router} />)
}

/** A player's per-GAME stroke row — the editable handicap list above it lists
 *  the same names, so match on the row that actually reports strokes. */
function strokeRow(name: string): HTMLElement {
  const row = screen
    .getAllByText(name)
    .map((el) => el.closest('li'))
    .find((li) => li?.textContent?.includes('strokes'))
  if (!row) throw new Error(`no stroke row for ${name}`)
  return row
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
    expect(strokeRow('Bogey')).toHaveTextContent('CH 18 · 14 strokes')
    expect(strokeRow('Scratch')).toHaveTextContent('CH 0 · 0 strokes')
    // config summary is surfaced
    expect(screen.getByText(/Skin value \$1/)).toBeInTheDocument()
  })

  it('adjusts a course handicap on blur, and re-derives the strokes', async () => {
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
    round.id = 'round-start-adjust'
    await db.rounds.put(round)

    renderStart(round.id)

    // Bogey teed off on 18 → 14 strokes at 80%. Drop the CH to 10 → 8 strokes.
    const input = await screen.findByLabelText('Bogey course handicap')
    expect(input).toHaveValue(18)
    fireEvent.change(input, { target: { value: '10' } })
    fireEvent.blur(input) // commit is on blur, not per keystroke

    await waitFor(async () => {
      expect((await db.rounds.get(round.id))!.players[1]!.courseHandicap).toBe(10)
    })
    await waitFor(() => expect(strokeRow('Bogey')).toHaveTextContent('CH 10 · 8 strokes'))
    // the reported index is a record of what they said — editing CH leaves it be
    expect((await db.rounds.get(round.id))!.players[1]!.handicapIndex).toBe(
      round.players[1]!.handicapIndex,
    )

    // a fat-fingered entry clamps instead of allocating triple-digit strokes
    fireEvent.change(input, { target: { value: '142' } })
    fireEvent.blur(input)
    await waitFor(async () => {
      expect((await db.rounds.get(round.id))!.players[1]!.courseHandicap).toBe(74)
    })
  })

  it('does not persist a half-typed or unchanged handicap', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Scratch', ch: 0 }, { name: 'Bogey', ch: 18 }]),
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: true },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    round.id = 'round-start-noop'
    await db.rounds.put(round)

    renderStart(round.id)
    const input = await screen.findByLabelText('Bogey course handicap')

    // clearing the box to retype must NOT write 0 — blurring empty reverts
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(input).toHaveValue(18)
    // opening the field and leaving it untouched writes nothing either
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect((await db.rounds.get(round.id))!.players[1]!.courseHandicap).toBe(18)
  })

  it('keeps multi-digit typing intact until blur, then commits once', async () => {
    // Regression: the box used to be controlled by the round, which is a Dexie
    // round-trip away — React reset it to the stale value between keystrokes, so
    // typing "22" over "14" landed as 142. Two changes with no await between
    // them reproduce that race; the DB is untouched until blur.
    const round = makeRound({
      players: makePlayers([{ name: 'Scratch', ch: 0 }, { name: 'Bogey', ch: 14 }]),
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: true },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    round.id = 'round-start-typing'
    await db.rounds.put(round)

    renderStart(round.id)

    const input = await screen.findByLabelText('Bogey course handicap')
    fireEvent.change(input, { target: { value: '2' } }) // first keystroke
    fireEvent.change(input, { target: { value: '22' } }) // second, before any commit
    expect(input).toHaveValue(22) // never snapped back to 14
    expect((await db.rounds.get(round.id))!.players[1]!.courseHandicap).toBe(14) // not yet

    fireEvent.blur(input)
    await waitFor(async () => {
      expect((await db.rounds.get(round.id))!.players[1]!.courseHandicap).toBe(22)
    })
  })

  it('locks handicaps once a hole is scored', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Scratch', ch: 0 }, { name: 'Bogey', ch: 18 }]),
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: true },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    round.id = 'round-start-locked'
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      { type: 'score/set', playerId: 'p-bogey', hole: 1, gross: 5 },
    ])

    renderStart(round.id)

    expect(await screen.findByText(/Locked — scoring has started/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Bogey course handicap')).not.toBeInTheDocument()
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
