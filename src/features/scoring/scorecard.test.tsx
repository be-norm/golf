import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { makePlayers, makeRound } from '../../engine/test/harness'
import { db } from '../../db/schema'
import { eventStore } from '../../db/eventStore'
import { routes } from '../../app/routes'

/**
 * "Where the money moved" — the per-hole ledger, and the first component test
 * this screen has ever had. The MATH behind it is well pinned (ledger.test.ts);
 * the presentation was not pinned at all, which is how it drifted into the wall
 * of text MAI-84 was raised about.
 */
describe('ScorecardScreen — where the money moved', () => {
  async function wolfCard(id: string, choice: string) {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }, { name: 'Cal' }, { name: 'Dee' }]),
      holes: 'front9',
      games: [
        {
          type: 'wolf',
          config: { pointCents: 100, rotation: ['p-ann', 'p-bob', 'p-cal', 'p-dee'] },
        },
      ],
    })
    round.id = id
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      { type: 'game/event', gameId: round.games[0]!.gameId, kind: 'wolf/pick', data: { hole: 1, choice } },
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: 1, gross: 5 },
      { type: 'score/set', playerId: 'p-cal', hole: 1, gross: 5 },
      { type: 'score/set', playerId: 'p-dee', hole: 1, gross: 5 },
    ])
    render(
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: [`/round/${id}/card`] })}
      />,
    )
    return round
  }

  /**
   * ONE SENTENCE, then the money, then the running total. The narration used to
   * enumerate every player's swing — which the money row prints again as cash
   * and the total row again as a running figure, so each of four names appeared
   * three times on a single card.
   */
  it('states who won the hole once, and leaves the numbers to the money rows', async () => {
    await wolfCard('card-partnered', 'p-bob')

    const card = (await screen.findByText(/win with/)).closest('li')!
    // Ann is the wolf on hole 1 and rides with Bob; Ann's 4 is the low ball
    expect(within(card).getByText("Ann & Bob win with Ann's 4")).toBeInTheDocument()
    // …and it says it ONCE: no second enumeration of the per-player swing
    expect(card.textContent).not.toContain('Ann +1')

    // the money that moved, and the running total after this hole
    expect(within(card).getByText('Ann +$1')).toBeInTheDocument()
    expect(within(card).getByText('Cal -$1')).toBeInTheDocument()
    expect(card.textContent).toContain('TOTAL:')
    expect(card.textContent).toContain('Ann +$1 · Bob +$1 · Cal -$1 · Dee -$1')
  })

  /**
   * The solo modes carry a glyph, and the WORD that tells you what it costs —
   * a 16px picture can't teach "the hole doubles" (engine/core/glyphs.ts). The
   * token must never reach the reader as literal text.
   */
  it('draws the wolf glyph in the ledger rather than printing its token', async () => {
    await wolfCard('card-lone', 'lone')

    const card = (await screen.findByText(/wins with/)).closest('li')!
    expect(within(card).getByText('Ann (lone) wins with 4')).toBeInTheDocument()
    // the cause line carries only the multiplier — the headline's label already
    // says who went lone
    expect(within(card).getByText('↳ lone wolf — the hole doubles')).toBeInTheDocument()
    expect(card.querySelector('[data-glyph="wolf"]')).not.toBeNull()
    expect(card.textContent).not.toContain(':wolf:')
    // a lone win is the doubled hole against each of three
    expect(within(card).getByText('Ann +$6')).toBeInTheDocument()
    expect(within(card).getByText('Bob -$2')).toBeInTheDocument()
  })
})

/**
 * The grids, for a round that teed off somewhere other than the first tee
 * (MAI-41). The tables run in WALK order, which is the order the ledger below
 * them already reads in and the order the front/back bets settled in.
 */
describe('ScorecardScreen — a round that teed off elsewhere', () => {
  async function renderCard(id: string, startHole?: number) {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      ...(startHole !== undefined && { startHole }),
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: false } }],
    })
    round.id = id
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      { type: 'score/set', playerId: 'p-ann', hole: startHole ?? 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: startHole ?? 1, gross: 5 },
    ])
    render(
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: [`/round/${id}/card`] })}
      />,
    )
    return round
  }

  /** the hole-number header cells of the nth table, in render order */
  const holeRow = (n: number) =>
    within(screen.getAllByRole('table')[n]!)
      .getAllByRole('columnheader')
      .map((th) => th.textContent)

  it('puts the nine it walked first on top, and says so', async () => {
    await renderCard('card-from-10', 10)
    expect(await screen.findByText('Teed off on 10 — top nine first')).toBeInTheDocument()
    expect(holeRow(0)).toEqual(['Hole', '10', '11', '12', '13', '14', '15', '16', '17', '18', '—'])
    expect(holeRow(1)).toEqual(['Hole', '1', '2', '3', '4', '5', '6', '7', '8', '9', '—'])
  })

  /**
   * An ordinary round is untouched — no note, and the card in the order every
   * golfer reads one. This is the regression half: the split changed from a
   * hole-number filter to a positional slice, and for every round played
   * before MAI-41 the two are the same thing.
   */
  it('leaves an ordinary round exactly as it was', async () => {
    await renderCard('card-from-1')
    expect(await screen.findByText(/Tap a cell/)).toBeInTheDocument()
    expect(screen.queryByText(/Teed off on/)).not.toBeInTheDocument()
    expect(holeRow(0)).toEqual(['Hole', '1', '2', '3', '4', '5', '6', '7', '8', '9', '—'])
    expect(holeRow(1)).toEqual(['Hole', '10', '11', '12', '13', '14', '15', '16', '17', '18', '—'])
  })
})
