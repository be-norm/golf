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
