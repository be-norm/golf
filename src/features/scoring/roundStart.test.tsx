import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { makeCourse, makePlayers, makeRound } from '../../engine/test/harness'
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
  /**
   * MAI-57. A game that can never pay anything says so AT THE FIRST TEE, which
   * is the last moment the group can do anything about it — every other note in
   * the catalog waits for `ctx.completed`, i.e. the settle screen, by which
   * time it is only an epitaph. The screen renders whatever a game has to say
   * without knowing any golf, so this is also the guard on that channel staying
   * quiet for everyone else.
   */
  it('states a bet that can never pay, before anybody tees off', async () => {
    // a card with no par 5 anywhere, so `holes: 'par5s'` designates nothing
    const par34s = makeCourse(
      [4, 4, 4, 3, 4, 4, 3, 4, 4, 4, 4, 3, 4, 4, 4, 3, 4, 4],
      [5, 13, 1, 9, 17, 3, 11, 7, 15, 6, 2, 16, 10, 4, 8, 18, 12, 14],
    )
    const round = makeRound({
      course: par34s,
      players: makePlayers([{ name: 'Ann' }, { name: 'Bo' }]),
      games: [
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
        { type: 'longDrive', config: { stakeCents: 200, holes: 'par5s' } },
      ],
    })
    round.id = 'round-inert-bet'
    await db.rounds.put(round)
    renderStart('round-inert-bet')

    expect(
      await screen.findByText(
        'No par 5s in the holes you are playing — long drive has nothing to play for',
      ),
    ).toBeInTheDocument()
  })

  /** …and nothing to say means nothing said. Every shipped note but the inert
   *  one is gated on `ctx.completed`, so a fresh round is silent. */
  it('says nothing at the first tee when no game has anything to report', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bo' }]),
      games: [
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
        { type: 'longDrive', config: { stakeCents: 200, holes: 'par5s' } },
      ],
    })
    round.id = 'round-quiet-start'
    await db.rounds.put(round)
    renderStart('round-quiet-start')

    await screen.findByText('Long Drive')
    expect(screen.queryByText(/nothing to play for/)).not.toBeInTheDocument()
  })

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

  /**
   * MAI-90, review round 1. The repo refuses `setCourseHandicap` on a
   * NON-EMPTY LOG, but this screen used to gate its fields on "anything
   * scored" — so any non-score event opened a gap where the fields rendered,
   * the typed number sat in local state looking accepted, the write was
   * rejected, and the round quietly kept the old course handicap. That
   * mis-allocates strokes for all 18 holes with nothing said.
   *
   * A putt tapped before the first score is an ordinary way to reach it, which
   * is what turned a latent divergence into an everyday one. A Wolf pick or a
   * CTP award does the same, and always could.
   */
  it('locks handicaps on ANY event, not just a score', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Scratch', ch: 0 }, { name: 'Bogey', ch: 18 }]),
      trackPutts: true,
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: true },
          handicap: { mode: 'net', allowancePct: 100, reference: 'offLow' },
        },
      ],
    })
    round.id = 'round-start-locked-by-putts'
    await db.rounds.put(round)
    // no score anywhere — just a putt count on the first hole
    await eventStore.append(round.id, [
      { type: 'score/putts', playerId: 'p-bogey', hole: 1, putts: 2 },
    ])

    renderStart(round.id)

    // the UI must agree with the write it would attempt
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

  /**
   * Where the round teed off, when that isn't where its range already says
   * (MAI-41). The first tee is the last screen before anyone hits a ball, so
   * it is where a group would catch a mistapped start hole.
   */
  describe('the hole range line', () => {
    const seed = async (
      id: string,
      opts: { holes?: 'front9' | 'back9' | 'full18'; startHole?: number },
    ) => {
      const round = makeRound({
        players: makePlayers([{ name: 'Ann' }, { name: 'Bo' }]),
        ...(opts.holes && { holes: opts.holes }),
        ...(opts.startHole !== undefined && { startHole: opts.startHole }),
        games: [{ type: 'skins', config: { stakeCents: 100, carryover: false } }],
      })
      round.id = id
      await db.rounds.put(round)
      renderStart(round.id)
    }

    it('names the hole an eighteen teed off on', async () => {
      await seed('start-from-10', { startHole: 10 })
      expect(await screen.findByText(/18 holes from 10/)).toBeInTheDocument()
    })

    it('says nothing extra when the round starts where its range says', async () => {
      await seed('start-plain', {})
      expect(await screen.findByText(/18 holes/)).toBeInTheDocument()
      // anchored to the range line's own shape. A bare /from/ matches any copy
      // on the screen — Skins' own rules say "collects the skin value from
      // every other player" — so the day the explainer renders, an unanchored
      // query goes ambiguous and fails for a reason unrelated to start holes.
      expect(screen.queryByText(/\d+ holes from/)).not.toBeInTheDocument()
    })

    /** a Back 9 already says it begins on 10 — announcing it again is noise */
    it('does not tell a Back 9 that it begins on 10', async () => {
      await seed('start-back9', { holes: 'back9', startHole: 10 })
      expect(await screen.findByText(/Back 9/)).toBeInTheDocument()
      expect(screen.queryByText(/\d+ holes from|Back 9 from/)).not.toBeInTheDocument()
    })

    /**
     * …but a Back 9 teed off on 13 does need saying, and it is STILL a Back 9:
     * it walks 13–18 then 10–12 and never leaves the nine, so the range keeps
     * its name and only gains a starting hole (MAI-41).
     */
    it('names a rotated nine as its own nine, plus where it started', async () => {
      await seed('start-back9-13', { holes: 'back9', startHole: 13 })
      expect(await screen.findByText(/Back 9 from 13/)).toBeInTheDocument()
    })

    /**
     * The DERIVED hole, never the stored one. `holesForRound` falls back for a
     * start hole the card hasn't got, so a round imported with hole 40 plays
     * 1–18 — and must not claim to have started on a hole nobody walked.
     */
    it('says nothing for a start hole the card has not got', async () => {
      await seed('start-bogus', { startHole: 40 })
      expect(await screen.findByText(/18 holes/)).toBeInTheDocument()
      expect(screen.queryByText(/\d+ holes from/)).not.toBeInTheDocument()
    })
  })
})
