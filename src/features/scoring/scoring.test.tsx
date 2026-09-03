import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { makeCourse, makePlayers, makeRound } from '../../engine/test/harness'
import { doubleNine } from '../../engine/core/tees'
import { db } from '../../db/schema'
import { eventStore } from '../../db/eventStore'
import { routes } from '../../app/routes'
import { deriveRound } from '../../engine/catalog'

describe('ScoringScreen', () => {
  /**
   * UNDO TAKES BACK WHAT YOU DID **HERE**.
   *
   * `↩ Undo` sits beside the score entry and reads as "undo that last tap".
   * Retracting the log's tail regardless of kind meant a stake changed minutes
   * ago on the SETTINGS screen was silently reverted by it — a different
   * surface, taking every hole's money with it. Each surface undoes its own kind
   * of action; a settings change is changed back where it was made.
   */
  it('undoes the last SCORE, not a settings change made on another screen', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Alice' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = 'round-undo-scope'
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      { type: 'score/set', playerId: 'p-ben', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-alice', hole: 1, gross: 5 },
      // …and then, on the settings screen, the stake is corrected
      {
        type: 'game/configured',
        gameId: round.games[0]!.gameId,
        config: { stakeCents: 500, carryover: true },
        handicap: round.games[0]!.handicap,
      },
    ])

    render(
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'undo' }))

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(4)
    })
    const events = await eventStore.list(round.id)
    const retract = events[3] as { type: string; targetEventId: string }
    // it reached past the amendment for Alice's score — the last thing done here
    expect(retract.type).toBe('meta/retract')
    expect(retract.targetEventId).toBe(events[1]!.id)
    // …and the stake correction is untouched
    expect(deriveRound(round, events).round.games[0]!.config).toEqual({
      stakeCents: 500,
      carryover: true,
    })
  })

  /**
   * THE DOCUMENT MEANS "AS TEED OFF", and finishing must not quietly rewrite it
   * (MAI-100/101).
   *
   * `view.round` is the AMENDED round — the document with every
   * `game/configured` folded on — so the old `roundRepo.put({ ...round, status })`
   * would have written those amendments straight back into `db.rounds`. Nothing
   * would look wrong: `amendRound` is idempotent, so the money stays right. But
   * the round would stop meaning what it says, and the log would no longer be
   * the only record of what the group changed.
   *
   * It was also a stale write in its own right — whatever the screen held in
   * memory won — which is why `setStatus` is a read-modify-write.
   */
  it('finishing an amended round leaves the document as it teed off', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Alice' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = 'round-amended-finish'
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      // every hole scored, so the bar offers Finish
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((hole) =>
        ['p-ben', 'p-alice'].map((playerId) => ({
          type: 'score/set' as const,
          playerId,
          hole,
          gross: 4,
        })),
      ),
      {
        type: 'game/configured',
        gameId: round.games[0]!.gameId,
        config: { stakeCents: 500, carryover: true },
        handicap: round.games[0]!.handicap,
      },
    ])

    render(
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Finish round/ }))

    await waitFor(async () => {
      expect((await db.rounds.get(round.id))?.status).toBe('completed')
    })
    // the stake the round teed off with, not the amended one
    expect((await db.rounds.get(round.id))?.games[0]!.config).toEqual({
      stakeCents: 100,
      carryover: true,
    })
  })

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
    expect(await screen.findByText('par 4 · si 5')).toBeInTheDocument()

    // one tap on Ben's chip confirms par
    const chip = await screen.findByRole('button', { name: 'Ben score' })
    await userEvent.click(chip)

    // the tap commits asynchronously — wait for the append to land
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(1)
    })
    const events = await eventStore.list(round.id)
    expect(events[0]).toMatchObject({ type: 'score/set', playerId: 'p-ben', hole: 1, gross: 4 })
  })

  /** A nine played twice around, as SetupScreen freezes it: card holes 1–18,
   *  where 14 is physically the 5th tee, second time round. */
  async function twiceAroundRound(id: string) {
    const nine = makeCourse([4, 4, 3, 4, 3, 4, 4, 4, 3], [6, 2, 8, 4, 9, 1, 5, 3, 7])
    const round = makeRound({
      course: doubleNine(nine),
      players: makePlayers([{ name: 'Ben' }, { name: 'Alice' }]),
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = id
    await db.rounds.put(round)
    return round
  }

  it('names the loop on the second time round', async () => {
    const round = await twiceAroundRound('round-two-loops')
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}?hole=14`] })
    render(<RouterProvider router={router} />)

    expect(await screen.findByText('2nd time round · hole 5')).toBeInTheDocument()
    // par/SI still come from the card — only the wayfinding changed
    expect(screen.getByText('par 3 · si 18')).toBeInTheDocument()
  })

  it('says nothing the first time round — hole 5 is just hole 5', async () => {
    const round = await twiceAroundRound('round-two-loops-first')
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}?hole=5`] })
    render(<RouterProvider router={router} />)

    await screen.findByText('Hole')
    expect(screen.queryByText(/time round/)).not.toBeInTheDocument()
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
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(1)
    })
    await userEvent.click(await screen.findByRole('button', { name: 'undo' }))

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(2)
    })
    const events = await eventStore.list(round.id)
    expect(events[1]).toMatchObject({ type: 'meta/retract', targetEventId: events[0]!.id })
  })

  /**
   * The failure path, which is the one that would hurt most: the guard marks
   * an id undone BEFORE the append is known to have landed. A rejected append
   * (quota, a DatabaseClosedError while another tab upgrades, an aborted
   * transaction) writes no retract at all — so the event is still live, still
   * `last`, and a permanent mark would make ↩ Undo silently dead for it, on
   * exactly the wrong score the scorekeeper is trying to fix.
   */
  it('stays undoable when the retract fails to write', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Cal' }, { name: 'Dee' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = 'round-undo-failed'
    await db.rounds.put(round)

    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Cal score' }))
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(1)
    })

    const undoButton = await screen.findByRole('button', { name: 'undo' })
    const failing = vi
      .spyOn(eventStore, 'append')
      .mockRejectedValueOnce(new Error('QuotaExceededError'))
    await userEvent.click(undoButton)
    await waitFor(() => {
      expect(failing).toHaveBeenCalledTimes(1)
    })
    // nothing was written, so the score is still there to undo
    expect(await eventStore.list(round.id)).toHaveLength(1)
    failing.mockRestore()

    // …and the next tap works, rather than hitting a guard holding an id whose
    // retract never landed
    await userEvent.click(undoButton)
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(2)
    })
    const events = await eventStore.list(round.id)
    expect(events[1]).toMatchObject({ type: 'meta/retract', targetEventId: events[0]!.id })
  })

  /**
   * The other half of guarding undo, and the one that would hurt: a PERMANENT
   * set must not suppress a legitimate later undo. It cannot, because
   * `effectiveEvents` strips retracted events — so a retracted id can never be
   * `last` again, and each tap targets something new. Asserted rather than
   * argued, because "the guard swallowed my undo" is a far worse bug than the
   * duplicate it prevents.
   */
  it('undoes repeatedly, one event at a time', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Cal' }, { name: 'Dee' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = 'round-undo-repeat'
    await db.rounds.put(round)

    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Cal score' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Dee score' }))
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(2)
    })

    const undoButton = await screen.findByRole('button', { name: 'undo' })
    for (const expected of [3, 4]) {
      await userEvent.click(undoButton)
      await waitFor(async () => {
        expect(await eventStore.list(round.id)).toHaveLength(expected)
      })
    }

    const events = await eventStore.list(round.id)
    const retracts = events.filter((e) => e.type === 'meta/retract')
    expect(retracts).toHaveLength(2)
    // two DIFFERENT targets, newest first — not the same event twice
    expect(retracts.map((e) => (e as { targetEventId: string }).targetEventId)).toEqual([
      events[1]!.id,
      events[0]!.id,
    ])
  })

  /**
   * The header ↩ Undo survives its own tap, so two quick taps read the same
   * render closure, compute the same `last` event, and retract it twice.
   * Replay shrugs — retract targets collect into a Set — but the duplicate
   * outlives the round in every export and archive, which is the harm every
   * other guard on this screen exists to prevent.
   */
  it('two taps on undo retract once, not twice', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Cal' }, { name: 'Dee' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = 'round-undo-twice'
    await db.rounds.put(round)

    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Cal score' }))
    // Wait for the SCREEN, not the database. `undo` reads the last event off
    // the rendered view, so clicking while the live query is still catching up
    // finds no event, returns early, and lands no retract at all — which is a
    // flake, not the race under test. The chip drops "par?" once its score is
    // in the derivation.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cal score' })).not.toHaveTextContent('par?')
    })

    const undoButton = await screen.findByRole('button', { name: 'undo' })
    fireEvent.click(undoButton)
    fireEvent.click(undoButton)

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(2)
    })
    const events = await eventStore.list(round.id)
    expect(events.filter((e) => e.type === 'meta/retract')).toHaveLength(1)
  })

  /**
   * The press affordance (MAI-34). The button is PULL — always tappable, never
   * interrupting — and only turns gold when the 2-down convention says act.
   * `holesWon` scripts Ann beating Bob on the given holes so a deficit builds.
   */
  async function nassauRound(id: string, holesWon: number[], autoPress = false) {
    // full 18 deliberately: a 9-hole round collapses to ONE bet, so the
    // multi-bet offer (F9 and 18 both live) would never be exercised
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      games: [{ type: 'nassau', config: { stakeCents: 500, teams: null, autoPress } }],
    })
    round.id = id
    round.games[0]!.handicap = { mode: 'gross', reference: 'offLow', allowancePct: 100 }
    await db.rounds.put(round)
    for (const hole of holesWon) {
      await eventStore.append(round.id, [
        { type: 'score/set', playerId: 'p-ann', hole, gross: 4 },
        { type: 'score/set', playerId: 'p-bob', hole, gross: 5 },
      ])
    }
    return round
  }

  const pressButton = () => screen.findByRole('button', { name: /press options/ })

  it('press button is tappable with nothing on offer, and says why', async () => {
    const round = await nassauRound('round-press-level', [])
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    const button = await pressButton()
    expect(button).toHaveAccessibleName('press options — 0 available')
    // never disabled: "why can't I press?" gets an answer, not a dead control
    expect(button).toBeEnabled()

    await userEvent.click(button)
    // states the rule rather than one of its causes — a bet can also be
    // unpressable because it has already been won
    expect(await screen.findByText(/needs a live bet you're down on/)).toBeInTheDocument()
  })

  it('offers a press at 1 down, quietly — no gold, no blink', async () => {
    const round = await nassauRound('round-press-one-down', [1])
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    const button = await screen.findByRole('button', {
      name: 'press options — 2 available',
    })
    expect(button.className).not.toContain('coin-500')
    expect(button.querySelector('.animate-blink')).toBeNull()

    await userEvent.click(button)
    // the sheet answers WHY, and names the hole the press starts from
    expect(await screen.findByText('Press from hole 2')).toBeInTheDocument()
    expect(screen.getByText('Bob 1 down · 8 to play')).toBeInTheDocument()
    expect(screen.getByText('New $5 bet · holes 2–9')).toBeInTheDocument()
  })

  it('goes gold at 2 down and taking a press appends exactly one event', async () => {
    const round = await nassauRound('round-press-two-down', [1, 2])
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    const button = await pressButton()
    expect(button.className).toContain('border-coin-500')
    // only the marker blinks, never the whole control
    expect(button.querySelector('.animate-blink')).not.toBeNull()

    await userEvent.click(button)
    expect(await screen.findByText('Bob 2 down · 7 to play')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Press F9/ }))

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(5) // 4 scores + the press
    })
    const events = await eventStore.list(round.id)
    expect(events[4]).toMatchObject({
      type: 'game/event',
      kind: 'nassau/press',
      data: { hole: 3, segment: 'front' },
    })

    // that segment stops being OFFERED — only the Overall is left to take
    await waitFor(async () => {
      expect(await pressButton()).toHaveAccessibleName('press options — 1 available')
    })
  })

  /**
   * MAI-38, end to end on the screen the scorekeeper is actually holding: a bet
   * the group has already won reads as won on the pinned bar, its money is in
   * the standings while eleven holes are still to play, and it drops out of the
   * press offer. The bar is the surface that used to hide this entirely —
   * it showed a decided bet as a running lead.
   */
  it('a decided bet reads as won on the bar, pays, and stops being pressable', async () => {
    const round = await nassauRound('round-press-closed', [1, 2, 3])
    // halve h4–h7 → Ann is 3 up with only h8 and h9 left on the front: 3&2
    for (const hole of [4, 5, 6, 7]) {
      await eventStore.append(round.id, [
        { type: 'score/set', playerId: 'p-ann', hole, gross: 4 },
        { type: 'score/set', playerId: 'p-bob', hole, gross: 4 },
      ])
    }
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    // the bar: front won outright, the overall still a running lead
    const bar = await screen.findByText('Ann wins 3&2')
    expect(bar).toBeInTheDocument()
    expect(screen.getByText('Ann ↑3')).toBeInTheDocument()

    // the money is real and visible mid-round, not deferred to the 9th green
    await userEvent.click(bar)
    expect(await screen.findByText('+$5')).toBeInTheDocument()
    const owed = screen.getByText('-$5')
    expect(screen.getByText('F9 ✓3&2 · B9 AS · 18 ↑3')).toBeInTheDocument()

    // An amount NEVER wraps. Sharing a row with three bets' worth of status
    // broke "-$5" between the minus and the digits on a phone, so the row read
    // as a player owing "$5" with a stray dash floating above it. The status
    // line is what yields: it sits on its own line, not beside the money.
    expect(owed.className).toContain('whitespace-nowrap')
    expect(owed.parentElement!.textContent).not.toContain('F9 ✓3&2')
    await userEvent.keyboard('{Escape}')

    // With auto-press OFF (this fixture) nothing lives under the won front, so
    // the segment drops off the offer entirely. Auto-press ON is the other
    // story — see nassau N21, where the surviving press keeps F9 pressable and
    // the offer has to say which bet is down.
    await userEvent.click(await pressButton())
    expect(await screen.findByRole('button', { name: /Press 18/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Press F9/ })).not.toBeInTheDocument()
  })

  /**
   * Two Nassaus at different stakes is a supported round (MAI-44 —
   * `duplicateInstanceProblems` blocks only IDENTICAL settings), and both speak
   * the same vocabulary. Counting declared copies rather than offering games
   * read that as two voices and fell back to the neutral "Actions", losing the
   * empty state that answers "why can't I press?".
   */
  it('keeps one game’s vocabulary when two instances of it are both offering', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
        { type: 'nassau', config: { stakeCents: 1000, teams: null, autoPress: false } },
      ],
    })
    round.id = 'round-two-nassaus'
    for (const g of round.games)
      g.handicap = { mode: 'gross', reference: 'offLow', allowancePct: 100 }
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: 1, gross: 5 },
    ])
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    // still "press options", not "actions options"
    const button = await screen.findByRole('button', { name: /press options/ })
    await userEvent.click(button)
    // …and the sheet still answers in Nassau's words. Both bets are down, so
    // four rows render — which is also what would collide on React keys if the
    // flat list keyed on `id` alone.
    expect(await screen.findByText('Press from hole 2')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Press F9/ })).toHaveLength(2)
  })

  it('no press offer while looking at a hole the group has already played', async () => {
    // holes 1–2 are in, so the group is on the 3rd tee — but the scorekeeper
    // has paged back to hole 1 to check a score. Nothing to press from here.
    const round = await nassauRound('round-press-off-frontier', [1, 2])
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}?hole=1`] })
    render(<RouterProvider router={router} />)

    await screen.findByText('Hole')
    expect(screen.queryByRole('button', { name: /press options/ })).not.toBeInTheDocument()
  })

  it('a taken press stays on the list and tapping it again takes it back', async () => {
    const round = await nassauRound('round-press-undo', [1, 2])
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    await userEvent.click(await pressButton())
    await userEvent.click(await screen.findByRole('button', { name: /Press F9/ }))
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(5)
    })

    // reopen: the press is still listed, engaged, and offering its own undo
    await userEvent.click(await pressButton())
    const taken = await screen.findByRole('button', { name: /Press F9/ })
    expect(taken).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByText('Running $5 bet · holes 3–9')).toBeInTheDocument()

    // tap it again → a retract lands, and the row goes back to a plain offer
    await userEvent.click(taken)
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(6)
    })
    const events = await eventStore.list(round.id)
    expect(events[5]).toMatchObject({ type: 'meta/retract', targetEventId: events[4]!.id })

    await waitFor(async () => {
      expect(await pressButton()).toHaveAccessibleName('press options — 2 available')
    })
  })

  it('two taps landing in the same frame retract once, not twice', async () => {
    // The undo button survives its own tap (the sheet stays open by design), so
    // a fast double-tap can land twice before React re-renders. Fired with
    // fireEvent, synchronously, because that IS the race — awaited clicks let
    // the row flip back to an offer in between, which is a different (and
    // correct) story: toggle off, toggle on.
    const round = await nassauRound('round-press-undo-twice', [1, 2])
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    await userEvent.click(await pressButton())
    await userEvent.click(await screen.findByRole('button', { name: /Press F9/ }))
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(5)
    })

    await userEvent.click(await pressButton())
    const taken = await screen.findByRole('button', { name: /Press F9/ })
    fireEvent.click(taken)
    fireEvent.click(taken) // same frame, row still reads as taken

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(6)
    })
    const events = await eventStore.list(round.id)
    // the append-only log outlives the round in every export and archive — one
    // compensation event, not two
    expect(events.filter((e) => e.type === 'meta/retract')).toHaveLength(1)
  })

  it('an auto-press shows as running but offers no undo — it is not the player’s', async () => {
    // auto-press on, 2 down after hole 2 → the rules opened a press at hole 3
    const round = await nassauRound('round-press-auto', [1, 2], true)
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)

    // nothing left to TAKE — both segments are already pressed by the rules
    const button = await screen.findByRole('button', { name: 'press options — 0 available' })
    await userEvent.click(button)

    const row = await screen.findByRole('button', { name: /Press F9/ })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(row).toBeDisabled()
    expect(row).toHaveTextContent(/auto/i)
    expect(row).not.toHaveTextContent(/tap to undo/i)

    // and tapping it changes nothing — no retract, no new events
    const before = await eventStore.list(round.id)
    await userEvent.click(row)
    expect(await eventStore.list(round.id)).toHaveLength(before.length)
  })
})

/**
 * MAI-90. Putts are a scorecard fact the round opts into. Two things matter
 * most here and neither is the happy path: a round NOT counting putts must be
 * untouched (every round played so far is that round), and the control must
 * never turn a fumbled tap into a WRONG count — 0 means chip-in, and a junk
 * game pays for one.
 */
/**
 * WHO IS CARRYING THE SNAKE — a live position that no money row can state.
 *
 * MAI-99 put this on the pinned bar, beside a side-bets money aggregate that
 * read "no money yet" because a bet settling at the end contributes zero to it.
 * MAI-106 took both off the bar: the bar recaps the primary game and the sheet
 * accounts. So the question is the same and the surface moved — the group opens
 * the sheet and the snake still says who has it and what it is worth.
 *
 * The rule that `openBet` is declared only while the position is NOT yet money
 * is the ENGINE's, and it is pinned there (ctp.test.ts, longDrive.test.ts,
 * snake). The screen-level version of that assertion went with the bar row it
 * was written against; this keeps the half that is still about a screen.
 */
describe('ScoringScreen — a live bet the money cannot show', () => {
  async function collapsedRound(id: string) {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
        { type: 'snake', config: { potCents: 500, doubling: false } },
        { type: 'ctp', config: { stakeCents: 200 } },
      ],
    })
    round.id = id
    await db.rounds.put(round)
    // hole 1 scored, and Bob three-putted it — nothing is owed until the end
    await eventStore.append(id, [
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: 1, gross: 5 },
      {
        type: 'game/event',
        gameId: round.games[1]!.gameId,
        kind: 'snake/bite',
        data: { hole: 1, playerId: 'p-bob' },
      },
    ])
    render(
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/round/${id}`] })} />,
    )
    return round
  }

  /**
   * THE AWARD GAMES' CARRY HAD NO OTHER HOME, and taking it off the bar nearly
   * lost it outright.
   *
   * The snake survives the move by luck: its own `detailLines` repeat its
   * position, so the sheet stated it either way. Closest to the Pin and Long
   * Drive declare NO detailLines and no per-hole recap while carrying — their
   * player cards read "$0 · 0 CTPs" while $4 rides on the next par 3 — so the
   * pinned bar was the only surface that ever said so. Reading `openBet` in the
   * sheet is what makes this true by contract for every award game rather than
   * by accident for one.
   */
  it("states an award game's carry in the sheet, where the money reads zero", async () => {
    const user = userEvent.setup()
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
        { type: 'ctp', config: { stakeCents: 200, carryover: true } },
      ],
    })
    round.id = 'round-carry-sheet'
    await db.rounds.put(round)
    // holes 1-5 played; hole 4 is the par 3 and nobody claimed it, so it carries
    await eventStore.append(
      round.id,
      [1, 2, 3, 4, 5].flatMap((hole) => [
        { type: 'score/set' as const, playerId: 'p-ann', hole, gross: 4 },
        { type: 'score/set' as const, playerId: 'p-bob', hole, gross: 5 },
      ]),
    )
    render(
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })}
      />,
    )

    await user.click(await screen.findByRole('button', { name: /standings/ }))

    expect(await screen.findByText('2 CTPs riding · $4')).toBeInTheDocument()
    // …while the settlement genuinely has nothing to say about it yet
    expect(screen.getAllByText('0 CTPs').length).toBe(2)
  })

  it('keeps the live position off the bar and states it in the sheet', async () => {
    await collapsedRound('round-open-bet')

    // the bar is the primary game and a count of the rest — nothing else
    const bar = await screen.findByRole('button', { name: /standings/ })
    expect(bar).toHaveTextContent('Skins')
    expect(bar).toHaveTextContent('2 more bets')
    expect(bar).not.toHaveTextContent('Bob · -$5')

    await userEvent.click(bar)

    // …and the sheet says who is carrying it and what it is worth
    const sheet = await screen.findByText('holds the snake')
    expect(sheet).toBeInTheDocument()
    expect(screen.getByText('Bob · -$5')).toBeInTheDocument()
  })
})

describe('ScoringScreen — putts', () => {
  async function puttsRound(id: string, trackPutts: boolean) {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      trackPutts,
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    round.id = id
    await db.rounds.put(round)
    render(
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/round/${id}`] })} />,
    )
    return round
  }

  const count = (name: string) => screen.findByLabelText(`${name} putts`)
  const more = (name: string) => screen.findByRole('button', { name: `${name} more putts` })
  const fewer = (name: string) => screen.findByRole('button', { name: `${name} fewer putts` })

  it('offers nothing at all when the round is not counting putts', async () => {
    await puttsRound('round-putts-off', false)

    await screen.findByText('Ann')
    expect(screen.queryByLabelText(/putts/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /putts/ })).not.toBeInTheDocument()
  })

  it('records a count, and one tap is one event', async () => {
    const round = await puttsRound('round-putts-on', true)

    // unrecorded reads as a question, not as zero — they are different facts
    expect(await count('Ann')).toHaveTextContent('putts?')
    await userEvent.click(await more('Ann'))

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(1)
    })
    expect((await eventStore.list(round.id))[0]).toMatchObject({
      type: 'score/putts',
      playerId: 'p-ann',
      hole: 1,
      putts: 1,
    })
    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('1 putts'))
  })

  /**
   * THE REGRESSION THAT REPLACED THE FIRST DESIGN. The control shows the
   * DERIVED count, which lags a tap by a write and a re-derive — so a value
   * computed from it made three quick taps append "1, 1, 1", leaving a
   * three-putt recorded as one and two duplicates in a log that syncs.
   * Tapping fast is exactly how a three-putt gets entered.
   */
  it('counts every tap in a burst, rather than the last one three times', async () => {
    const round = await puttsRound('round-putts-burst', true)

    const plus = await more('Bob')
    fireEvent.click(plus)
    fireEvent.click(plus)
    fireEvent.click(plus)

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(3)
    })
    const events = await eventStore.list(round.id)
    expect(events.map((e) => (e as { putts: number }).putts)).toEqual([1, 2, 3])
    await waitFor(async () => expect(await count('Bob')).toHaveTextContent('3 putts'))
  })

  /**
   * The way back to NOT RECORDED. Without it the only erase gesture is to enter
   * 0, which does not mean "I mis-tapped" — it means chip-in, and Dots pays for
   * one. Stepping down off zero clears the fact instead.
   */
  it('steps down off zero to not-recorded, never leaving a false chip-in', async () => {
    const round = await puttsRound('round-putts-clear', true)

    await userEvent.click(await more('Ann')) // 1
    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('1 putts'))
    await userEvent.click(await fewer('Ann')) // 0 — a real chip-in
    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('0 putts'))
    await userEvent.click(await fewer('Ann')) // …and back to nothing at all

    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('putts?'))
    const events = await eventStore.list(round.id)
    expect(events[events.length - 1]).toMatchObject({
      type: 'score/puttsClear',
      playerId: 'p-ann',
      hole: 1,
    })
    // nothing was deleted to get there — invariant #2 holds
    expect(events.every((e) => e.type !== 'meta/retract')).toBe(true)
  })

  /**
   * MAI-90, review round 2. The ref could not say "I have sent a clear", so
   * after one it fell back to the DERIVED count — stale by construction, the
   * clear not having landed — and stepping up went to 2 from a hole the user
   * had just emptied.
   *
   * FIRED SYNCHRONOUSLY, and that is the test, not a detail: `userEvent`
   * awaits and flushes between clicks, so every write lands before the next tap
   * and the stale path is never taken. Written with `userEvent` first, this
   * passed against the bug it was written for.
   */
  it('steps up from a clear it has sent, not from the count it replaced', async () => {
    const round = await puttsRound('round-putts-after-clear', true)

    await userEvent.click(await more('Ann'))
    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('1 putts'))

    // 1 → 0 → not recorded → back up to one putt, all in one frame.
    // Both buttons resolved BEFORE either is clicked: an `await` between taps
    // flushes microtasks, the writes land, and the stale path this exists for
    // is never taken.
    const minus = await fewer('Ann')
    const plus = await more('Ann')
    fireEvent.click(minus)
    fireEvent.click(minus)
    fireEvent.click(plus)

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(4)
    })
    const events = await eventStore.list(round.id)
    expect(events.map((e) => `${e.type}${'putts' in e ? ':' + e.putts : ''}`)).toEqual([
      'score/putts:1',
      'score/putts:0',
      'score/puttsClear',
      'score/putts:1',
    ])
    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('1 putts'))
  })

  /**
   * Counting survives unrelated writes to the round row, which re-fire the live
   * query underneath the stepper.
   *
   * HONEST LIMIT: this does NOT isolate the release rule it was written for.
   * The defect needs an emission to arrive while a putt write is still in
   * flight, and nothing at this layer can order those two — with each tap
   * awaited, the wholesale release that caused the bug passes this too. The
   * per-key release is kept on reasoning, not on this test.
   */
  it('keeps counting across unrelated writes to the round', async () => {
    const round = await puttsRound('round-putts-interrupted', true)

    for (const expected of ['1 putts', '2 putts', '3 putts']) {
      await db.rounds.update(round.id, { updatedAt: new Date().toISOString() })
      await userEvent.click(await more('Bob'))
      await waitFor(async () => expect(await count('Bob')).toHaveTextContent(expected))
    }
    const events = await eventStore.list(round.id)
    expect(events.map((e) => (e as { putts: number }).putts)).toEqual([1, 2, 3])
  })

  /**
   * A putt that gets UNDONE. The pending ref shadows the derivation, so if it
   * never releases the stepper keeps stepping from a count the round no longer
   * has — the screen says 'putts?' and the next tap writes 2.
   */
  it('forgets a count that was undone', async () => {
    await puttsRound('round-putts-undone', true)

    await userEvent.click(await more('Ann'))
    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('1 putts'))

    await userEvent.click(screen.getByRole('button', { name: 'undo' }))
    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('putts?'))

    // the hole is empty again, so the next tap means ONE
    await userEvent.click(await more('Ann'))
    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('1 putts'))
  })

  it('cannot step below not-recorded', async () => {
    const round = await puttsRound('round-putts-floor', true)

    expect(await fewer('Ann')).toBeDisabled()
    expect(await eventStore.list(round.id)).toHaveLength(0)
  })

  it('keeps putts per hole, not per round', async () => {
    const round = await puttsRound('round-putts-per-hole', true)

    await userEvent.click(await more('Ann'))
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(1)
    })
    await userEvent.click(screen.getByRole('button', { name: 'next hole' }))

    // hole 2 knows nothing about hole 1's count
    await waitFor(async () => expect(await count('Ann')).toHaveTextContent('putts?'))
  })
})

/**
 * MAI-46 — the award channel, on the screen the scorekeeper is holding.
 *
 * The grid's whole reason for existing is the two gates it does NOT have. The
 * press affordance is frontier-gated and disappears once every hole is scored,
 * which is correct for a press and fatal for a greenie you remembered five
 * holes later — so the two tests that matter most here are the direct
 * contrasts with the press tests above.
 */
describe('ScoringScreen — award grid', () => {
  /** Front nine of the default card: pars 4 4 5 3 4 4 3 5 4 → par 3s on 4 and 7. */
  async function ctpRound(id: string, scoredHoles: number[] = []) {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [{ type: 'ctp', config: { stakeCents: 200 } }],
    })
    round.id = id
    await db.rounds.put(round)
    for (const hole of scoredHoles) {
      await eventStore.append(round.id, [
        { type: 'score/set', playerId: 'p-ann', hole, gross: 4 },
        { type: 'score/set', playerId: 'p-bob', hole, gross: 5 },
      ])
    }
    return round
  }

  const showHole = (round: { id: string }, hole: number) => {
    const router = createMemoryRouter(routes, {
      initialEntries: [`/round/${round.id}?hole=${hole}`],
    })
    render(<RouterProvider router={router} />)
  }

  const cell = (name: string) =>
    screen.findByRole('button', { name: `Closest to the pin — ${name}` })

  /**
   * A cell's accessible NAME doesn't change when it lights up, so `findByRole`
   * happily resolves the stale button before the live query has re-derived —
   * and the next tap would then call onTake instead of onUndo. Wait on the
   * state, never on the element.
   */
  const litCell = async (name: string) => {
    await waitFor(async () => {
      expect(await cell(name)).toHaveAttribute('aria-pressed', 'true')
    })
    return cell(name)
  }

  it('offers a cell per player on a par 3, and nothing on a par 4', async () => {
    const round = await ctpRound('round-award-par3')
    showHole(round, 4)

    expect(await cell('Ann')).toHaveAttribute('aria-pressed', 'false')
    expect(await cell('Bob')).toBeInTheDocument()
    const grid = within(screen.getByRole('region', { name: 'Awards' }))
    expect(grid.getByText('Closest to the pin')).toBeInTheDocument()
    // ONE award game names no game. The heading disambiguates, and there is
    // nothing here to disambiguate — CTP's only row is named after the game, so
    // an unconditional heading stacked "Closest to the Pin" straight on top of
    // "Closest to the pin". Caught by running it, not by a test.
    expect(grid.queryByText('Closest to the Pin')).not.toBeInTheDocument()
  })

  /** …and the case the heading WAS written for: two games handing out awards on
   *  the same hole, where "whose greenie is this?" is a real question. */
  it('names each game once two of them are giving things out on the same hole', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'ctp', config: { stakeCents: 200 } },
        { type: 'ctp', config: { stakeCents: 500 } },
      ],
    })
    round.id = 'round-award-two-games'
    await db.rounds.put(round)
    showHole(round, 4)

    const grid = within(await screen.findByRole('region', { name: 'Awards' }))
    // gameLabel discriminates two instances by stake, so both headings render
    expect(grid.getByText('Closest to the Pin ($2)')).toBeInTheDocument()
    expect(grid.getByText('Closest to the Pin ($5)')).toBeInTheDocument()
  })

  it('says nothing at all on a hole with no awards to give', async () => {
    const round = await ctpRound('round-award-par4')
    showHole(round, 5)

    await screen.findByText('Hole')
    expect(screen.queryByRole('region', { name: 'Awards' })).not.toBeInTheDocument()
  })

  it('one tap appends exactly one award event, naming the hole', async () => {
    const round = await ctpRound('round-award-tap')
    showHole(round, 7)

    await userEvent.click(await cell('Bob'))
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(1)
    })
    const events = await eventStore.list(round.id)
    expect(events[0]).toMatchObject({
      type: 'game/event',
      kind: 'ctp/award',
      // `hole` in the PAYLOAD, not just in the UI: buildHoleLedger places a
      // game event in its prefix replay by reading it, and an award is the one
      // thing recorded long after the hole it names
      data: { hole: 7, playerId: 'p-bob' },
    })
  })

  /**
   * THE CONTRAST WITH `no press offer while looking at a hole the group has
   * already played`. Same situation — the group is on the 3rd tee, the
   * scorekeeper has paged back — and the opposite, correct answer.
   */
  it('still offers awards on a hole behind the frontier', async () => {
    // holes 1–3 in, so hole 4 is the frontier; page back to the par 3 on… no,
    // hole 4 IS the par 3, so score through it and page back to it
    const round = await ctpRound('round-award-behind', [1, 2, 3, 4, 5])
    showHole(round, 4)

    const bob = await cell('Bob')
    expect(bob).toBeEnabled()
    // and there is no press-style affordance withdrawing it
    await userEvent.click(bob)
    await waitFor(async () => {
      expect((await eventStore.list(round.id)).some((e) => e.type === 'game/event')).toBe(true)
    })
  })

  /**
   * THE CONTRAST WITH the `offersActions && onFrontier && !allScored` gate: a
   * mistapped KP has to stay fixable after the last putt drops and before
   * anyone taps Finish.
   */
  it('still offers awards once every hole is scored', async () => {
    const round = await ctpRound('round-award-all-scored', [1, 2, 3, 4, 5, 6, 7, 8, 9])
    showHole(round, 7)

    // the bar has already flipped to Finish, and the grid is still live
    expect(await screen.findByRole('button', { name: /Finish round/ })).toBeInTheDocument()
    expect(await cell('Ann')).toBeEnabled()
  })

  it('tapping the lit cell takes the award back', async () => {
    const round = await ctpRound('round-award-undo')
    showHole(round, 4)

    await userEvent.click(await cell('Ann'))
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(1)
    })

    await userEvent.click(await litCell('Ann'))

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(2)
    })
    const events = await eventStore.list(round.id)
    expect(events[1]).toMatchObject({ type: 'meta/retract', targetEventId: events[0]!.id })
    await waitFor(async () => {
      expect(await cell('Ann')).toHaveAttribute('aria-pressed', 'false')
    })
  })

  /**
   * The cell survives its own tap, so a fast double-tap lands twice before the
   * re-derive. The append-only log outlives the round in every export and
   * archive — one compensation event, not two. (Same race, same guard, as the
   * press row; fired synchronously because that IS the race.)
   */
  /**
   * The take half of the same race. An award cell survives its own tap — unlike
   * an actions row, whose sheet closes — so two taps land before the re-derive.
   * The log is append-only and syncs, so the duplicate would outlive the round
   * in every export, and the first award game to COUNT its events rather than
   * treat them as a set would double-pay on a fumbled tap.
   */
  it('two taps landing in the same frame award once, not twice', async () => {
    const round = await ctpRound('round-award-take-twice')
    showHole(round, 4)

    const untaken = await cell('Ann')
    fireEvent.click(untaken)
    fireEvent.click(untaken)

    await waitFor(async () => {
      expect(await litCell('Ann')).toBeInTheDocument()
    })
    expect(await eventStore.list(round.id)).toHaveLength(1)
  })

  /**
   * The guard has to be keyed WITH THE GAME. `Award.id` is unique only within
   * one game — an engine cannot see its siblings — so two CTPs both mint
   * `ctp-4-p-ann`, and a bare-id guard makes the second game's tap vanish with
   * no feedback at all.
   */
  it('guards each game separately when two of them offer the same cell', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'ctp', config: { stakeCents: 200 } },
        { type: 'ctp', config: { stakeCents: 500 } },
      ],
    })
    round.id = 'round-award-two-guards'
    await db.rounds.put(round)
    showHole(round, 4)

    // one cell per game, both named for Ann, tapped in the same frame
    const anns = await screen.findAllByRole('button', { name: 'Closest to the pin — Ann' })
    expect(anns).toHaveLength(2)
    fireEvent.click(anns[0]!)
    fireEvent.click(anns[1]!)

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(2)
    })
    const events = await eventStore.list(round.id)
    expect(new Set(events.map((e) => (e as { gameId: string }).gameId)).size).toBe(2)
  })

  /** …and the guard must not wedge: giving an award back and taking it again
   *  reuses the same offer id, and has to keep working. */
  it('lets the same cell be taken again after it is given back', async () => {
    const round = await ctpRound('round-award-retake')
    showHole(round, 4)

    await userEvent.click(await cell('Ann'))
    await userEvent.click(await litCell('Ann'))
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(2) // award + retract
    })
    await userEvent.click(await cell('Ann'))

    await waitFor(async () => {
      expect(await litCell('Ann')).toBeInTheDocument()
    })
    expect(await eventStore.list(round.id)).toHaveLength(3)
  })

  it('two taps landing in the same frame retract once, not twice', async () => {
    const round = await ctpRound('round-award-undo-twice')
    showHole(round, 4)

    await userEvent.click(await cell('Bob'))
    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(1)
    })

    const lit = await litCell('Bob')
    fireEvent.click(lit)
    fireEvent.click(lit)

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(2)
    })
    const events = await eventStore.list(round.id)
    expect(events.filter((e) => e.type === 'meta/retract')).toHaveLength(1)
  })
})

/**
 * The blocking channel survives its own tap for the same reason the award cell
 * does — the chip stays mounted until a re-derive removes it — so it needs the
 * same guard. Wolf's reducer is last-write-wins, so no money moves wrongly
 * today; the duplicate would just outlive the round in every export.
 */
describe('ScoringScreen — input chips', () => {
  async function wolfRound(id: string) {
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
    render(
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/round/${id}`] })} />,
    )
    return round
  }

  it('two taps landing in the same frame answer once, not twice', async () => {
    const round = await wolfRound('round-input-twice')

    const lone = await screen.findByRole('button', { name: /Lone Wolf/ })
    fireEvent.click(lone)
    fireEvent.click(lone)

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(1)
    })
    // settle: a second identical pick would land here if the guard were absent.
    // The teams block appearing is what says the answer landed.
    await screen.findByText('vs.')
    expect(await eventStore.list(round.id)).toHaveLength(1)
  })

  /**
   * DEDUPING IS FOR THE SAME ANSWER TWICE — changing your mind must get
   * through. The options of one prompt are adjacent buttons in a wrapping row,
   * so a slip-tap on a partner followed at once by the intended Lone Wolf is
   * an ordinary miss. Keying the guard on the PROMPT rather than the ANSWER
   * kept the partner: a different hole multiplier and different sides, so
   * wrong money — worse than the duplicate the guard was added to prevent.
   */
  it('lets a corrected answer through, and keeps the correction', async () => {
    const round = await wolfRound('round-input-corrected')

    // BOTH resolved before either is clicked. An `await` between the two taps
    // lets the first append re-derive and unmount the prompt, so the second
    // query races the teardown — which is a flake, not the scenario. The
    // scenario is two taps in ONE frame, and this is what that looks like.
    const partner = await screen.findByRole('button', { name: 'Bob' })
    const lone = screen.getByRole('button', { name: /Lone Wolf/ })
    fireEvent.click(partner)
    fireEvent.click(lone)

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(2)
    })
    const events = await eventStore.list(round.id)
    // last write wins in replay, so the pick the scorekeeper meant is the one
    // that counts — but only if the second tap was allowed to land at all
    expect(events.map((e) => (e as { data: { choice: string } }).data.choice)).toEqual([
      'p-bob',
      'lone',
    ])
    // the picker collapses, so the hole computed on the corrected pick — and
    // what replaces it states the teams that correction produced
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Lone Wolf/ })).not.toBeInTheDocument()
    })
    expect(screen.getByText(/Ann \(lone\)/)).toBeInTheDocument()
  })

  /**
   * MAI-84. The teams used to vanish the instant they were picked: nothing on
   * the scoring screen said who was partnered with whom, and a mistapped
   * partner was only reachable while it was still the round's LAST event (the
   * header undo retracts the tail of the log, whatever it is).
   */
  it('states the teams after the pick, with the picker collapsed', async () => {
    await wolfRound('round-input-teams')

    fireEvent.click(await screen.findByRole('button', { name: 'Bob' }))

    // Ann is the wolf on hole 1 and rides with Bob
    await screen.findByText('Ann & Bob')
    expect(screen.getByText('vs.')).toBeInTheDocument()
    expect(screen.getByText('Cal & Dee')).toBeInTheDocument()
    // the wolf mark rides EVERY pick, on the player holding the tee — and it is
    // the plain wolf, since nobody has called blind
    expect(document.querySelector('[data-glyph="wolf"]')).not.toBeNull()
    expect(document.querySelector('[data-glyph="wolf-shades"]')).toBeNull()
    // and the options are put away until asked for
    expect(screen.queryByRole('button', { name: /Lone Wolf/ })).not.toBeInTheDocument()
  })

  it('reopens the picker on Adjust, with the current answer engaged', async () => {
    const round = await wolfRound('round-input-adjust')

    fireEvent.click(await screen.findByRole('button', { name: 'Bob' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Adjust' }))

    const bob = screen.getByRole('button', { name: 'Bob' })
    expect(bob.className).toContain('border-felt-500')
    expect(screen.getByRole('button', { name: 'Cal' }).className).not.toContain('border-felt-500')

    fireEvent.click(screen.getByRole('button', { name: 'Cal' }))

    await screen.findByText('Ann & Cal')
    const events = await eventStore.list(round.id)
    expect(events.map((e) => (e as { data: { choice: string } }).data.choice)).toEqual([
      'p-bob',
      'p-cal',
    ])
    // the picker closes again behind the corrected teams
    expect(screen.queryByRole('button', { name: 'Adjust' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cal' })).not.toBeInTheDocument()
  })

  /**
   * `emitOnce` releases its key once the event lands, so a tap on the answer
   * ALREADY in effect would otherwise append a second identical wolf/pick —
   * inert in replay (last write wins) but permanent in an append-only log that
   * syncs and exports.
   */
  it('writes nothing when the answer in effect is tapped again', async () => {
    const round = await wolfRound('round-input-same')

    fireEvent.click(await screen.findByRole('button', { name: 'Bob' }))
    await screen.findByText('Ann & Bob')
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }))

    await screen.findByText('Ann & Bob')
    expect(await eventStore.list(round.id)).toHaveLength(1)
  })

  /**
   * BACK TO AN ANSWER ALREADY IN THE LOG, all inside one re-derive.
   *
   * The option row stays open until `answered` arrives, so Bob → Cal → Bob at
   * the tee is ordinary indecision, not a fumble. The third tap's payload is
   * byte-identical to the first, and while these went through `emitOnce` its
   * key was still held — so it returned having written nothing, by a path with
   * no rollback. The log stopped at Cal while the intent map said Bob, and
   * because that map only released on the derivation REPORTING Bob, tapping Bob
   * was a permanent silent no-op from then on: the panel kept saying Ann & Cal
   * and the partner the group meant could not be restored.
   */
  it('takes a third tap back to the first answer, all before any re-derive', async () => {
    const round = await wolfRound('round-input-there-and-back')

    const bob = await screen.findByRole('button', { name: 'Bob' })
    const cal = screen.getByRole('button', { name: 'Cal' })
    fireEvent.click(bob)
    fireEvent.click(cal)
    fireEvent.click(bob)

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(3)
    })
    const events = await eventStore.list(round.id)
    expect(events.map((e) => (e as { data: { choice: string } }).data.choice)).toEqual([
      'p-bob',
      'p-cal',
      'p-bob',
    ])
    // last write wins, so the teams are the ones the third tap meant
    await screen.findByText('Ann & Bob')
  })

  /**
   * …and the guard must step from what was SENT, not from the derivation,
   * which lags the write by an append, a live query and a re-derive. Comparing
   * against `input.answered` meant that answering and then reverting inside
   * that window read the OLD answer as "already in effect" and silently
   * dropped the revert — the same class of bug the putts stepper documents at
   * length, and the reason this file guards on intent everywhere else.
   */
  it('lets a revert through while the previous answer is still in flight', async () => {
    const round = await wolfRound('round-input-revert')

    fireEvent.click(await screen.findByRole('button', { name: 'Bob' }))
    await screen.findByText('Ann & Bob')
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }))
    // Cal, then straight back to Bob — no await between, so the panel still
    // says Bob when the second tap lands
    fireEvent.click(screen.getByRole('button', { name: 'Cal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }))

    await waitFor(async () => {
      expect(await eventStore.list(round.id)).toHaveLength(3)
    })
    const events = await eventStore.list(round.id)
    expect(events.map((e) => (e as { data: { choice: string } }).data.choice)).toEqual([
      'p-bob',
      'p-cal',
      'p-bob',
    ])
    // and the teams the scorekeeper meant are the ones on screen
    await screen.findByText('Ann & Bob')
  })

  /**
   * Two Wolfs at different stakes is a supported round (MAI-44 —
   * `duplicateInstanceProblems` blocks only IDENTICAL settings), and both mint
   * `wolf-pick-1`. So the panels must be keyed on `${gameId}:${id}` (or React
   * collapses them and one Adjust opens both) and they must SAY which stake
   * they belong to, since "Ann rides with…" twice over names neither.
   */
  it('names the game when two of them ask on the same hole', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }, { name: 'Cal' }, { name: 'Dee' }]),
      holes: 'front9',
      games: [
        {
          type: 'wolf',
          config: { pointCents: 100, rotation: ['p-ann', 'p-bob', 'p-cal', 'p-dee'] },
        },
        {
          type: 'wolf',
          config: { pointCents: 500, rotation: ['p-ann', 'p-bob', 'p-cal', 'p-dee'] },
        },
      ],
    })
    round.id = 'round-two-wolves'
    await db.rounds.put(round)
    render(
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })}
      />,
    )

    // `gameLabel` earns a discriminator only for a repeated type (MAI-42)
    expect(await screen.findAllByText('Wolf ($1)')).not.toHaveLength(0)
    expect(screen.getAllByText('Wolf ($5)')).not.toHaveLength(0)
    // two separate panels, each with its own options
    expect(screen.getAllByRole('button', { name: /Lone Wolf/ })).toHaveLength(2)

    // answering one leaves the other still asking
    fireEvent.click(screen.getAllByRole('button', { name: 'Bob' })[0]!)
    await screen.findByText('Ann & Bob')
    expect(screen.getAllByRole('button', { name: /Lone Wolf/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Adjust' })).toHaveLength(1)
  })

  /**
   * A settled round STATES its teams but does not revise them — the money has
   * been shared and pushed. Same gate as `AwardGrid`, and Reopen is the path.
   * But only the Adjust button: a pick that was never made is the one thing
   * still missing from the card, so an unanswered prompt stays live.
   */
  it('states the teams on a completed round without offering to change them', async () => {
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
    round.id = 'round-completed-teams'
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      {
        type: 'game/event',
        gameId: round.games[0]!.gameId,
        kind: 'wolf/pick',
        data: { hole: 1, choice: 'p-bob', wolf: 'p-ann' },
      },
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-cal', hole: 1, gross: 5 },
      { type: 'score/set', playerId: 'p-dee', hole: 1, gross: 5 },
      { type: 'round/completed' },
    ])
    render(
      <RouterProvider
        router={createMemoryRouter(routes, {
          initialEntries: [`/round/${round.id}?hole=1`],
        })}
      />,
    )

    // the teams are readable — before this they vanished on tap and a settled
    // round showed nothing at all
    await screen.findByText('Ann & Bob')
    expect(screen.queryByRole('button', { name: 'Adjust' })).not.toBeInTheDocument()
    // and the picker cannot be reached another way
    expect(screen.queryByRole('button', { name: /Lone Wolf/ })).not.toBeInTheDocument()
  })

  /**
   * An UNANSWERED pick on a settled round is worth saying — it is why that
   * hole's money reads the way it does — but it must not be answerable here.
   * `enqueuePushRound` runs in `finish()` and nowhere else, so a pick recorded
   * now would move the money on this device only: the synced archive keeps the
   * old numbers, and a reinstatement restores them. Reopen → record → Finish
   * is the flow that pushes.
   */
  it('shows a missing pick on a completed round, but sends you to Reopen', async () => {
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
    round.id = 'round-completed-unpicked'
    await db.rounds.put(round)
    // hole 1 scored, never picked, then the group walks in
    await eventStore.append(round.id, [
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-cal', hole: 1, gross: 5 },
      { type: 'score/set', playerId: 'p-dee', hole: 1, gross: 5 },
      { type: 'round/completed' },
    ])
    render(
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: [`/round/${round.id}?hole=1`] })}
      />,
    )

    expect(await screen.findByText(/Ann rides with/)).toBeInTheDocument()
    expect(screen.getByText('Reopen the round to record it.')).toBeInTheDocument()
    // no way to answer it from here — that would move money the archive can
    // never learn about
    expect(screen.queryByRole('button', { name: /Lone Wolf/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bob' })).not.toBeInTheDocument()
    expect(await eventStore.list(round.id)).toHaveLength(5)
  })

  /** The picture never carries the meaning alone (engine/core/glyphs.ts). */
  it('draws the wolf in shades for a blind pick, beside the word', async () => {
    await wolfRound('round-input-blind')

    fireEvent.click(await screen.findByRole('button', { name: /Blind Wolf/ }))

    await screen.findByText(/Ann \(blind\)/)
    expect(document.querySelector('[data-glyph="wolf-shades"]')).not.toBeNull()
  })

  /**
   * MAI-84. Opening the sheet used to lead with the running money and bury
   * what had just happened underneath it. Universal rather than Wolf-only:
   * `holeSummary` is a per-hole recap by contract for every game.
   *
   * Still the hole ON SCREEN, not the latest DECIDED one — recapping the hole
   * you walked back to is the sheet's job; the latest decided hole is the
   * pinned bar's.
   */
  it('leads the standings sheet with the hole recap, then the player cards', async () => {
    const round = await wolfRound('round-sheet-order')
    fireEvent.click(await screen.findByRole('button', { name: 'Bob' }))
    await eventStore.append(round.id, [
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: 1, gross: 5 },
      { type: 'score/set', playerId: 'p-cal', hole: 1, gross: 5 },
      { type: 'score/set', playerId: 'p-dee', hole: 1, gross: 5 },
    ])

    await userEvent.click(await screen.findByText(/Ann & Bob \+1/))

    const recap = await screen.findByText(/win with Ann's/)
    const firstCard = screen.getAllByText('+$1')[0]!
    // the recap precedes the first player card in document order
    expect(recap.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

/**
 * MAI-50. Density for a round of many games — five games once meant five rows
 * over a phone keyboard.
 *
 * The BAR half of this ticket is superseded: MAI-104 put the bar in flow so it
 * reserves its own height, and MAI-106 reduced it to one game plus a count, so
 * there is no longer a bar row per game to collapse. What survives, and what
 * these tests now cover, is the SHEET half — side bets grouped under their own
 * heading when there are enough of them to be worth grouping. The share card
 * half is untouched and lives in summaryCard's own tests.
 */
describe('ScoringScreen — density: grouping in the standings sheet', () => {
  /** A nassau main event plus `sideCount` skins side bets. */
  async function roundWith(id: string, sideCount: number) {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
        ...Array.from({ length: sideCount }, (_, i) => ({
          type: 'skins',
          config: { stakeCents: 100 + i, carryover: true },
        })),
      ],
    })
    round.id = id
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: 1, gross: 5 },
    ])
    return round
  }

  const show = (round: { id: string }) => {
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    render(<RouterProvider router={router} />)
  }

  it('groups two or more side bets under one heading in the sheet', async () => {
    show(await roundWith('round-bar-collapse', 3))
    await userEvent.click(await screen.findByRole('button', { name: /standings/ }))

    // the side bets sit under their own heading. Not asserting the main game
    // here: "Nassau" is in the DOM twice now (bar recap + sheet panel), so a
    // bare getByText would throw on the ambiguity rather than test anything.
    expect(await screen.findByText('Side bets')).toBeInTheDocument()
    // every side bet still gets its own panel UNDER that heading — grouping is
    // a heading, not a merge. Matched as a PATTERN because the three instances
    // differ by stake, so `gameLabel` renders them "Skins ($1)", "Skins
    // ($1.01)", "Skins ($1.02)" and the bare string "Skins" is never in the DOM.
    expect(screen.getAllByText(/^Skins \(/)).toHaveLength(3)
  })

  /**
   * Nassau + one Skins is the most common two-game round there is, and
   * collapsing there would trade the bar's latest-hole recap for no row saved.
   */
  it('does not raise a heading over a lone side bet', async () => {
    show(await roundWith('round-bar-lone', 1))
    await userEvent.click(await screen.findByRole('button', { name: /standings/ }))

    expect(await screen.findByText('Skins')).toBeInTheDocument()
    expect(screen.queryByText('Side bets')).not.toBeInTheDocument()
  })

  it('has nothing to group in a round of only side bets', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
        { type: 'skins', config: { stakeCents: 200, carryover: true } },
      ],
    })
    round.id = 'round-bar-all-side'
    await db.rounds.put(round)
    show(round)

    // roleOf makes the first "either" game the main event, so there is no
    // all-side round to collapse — and the bar says nothing about side bets
    expect(await screen.findByText('Skins ($1)')).toBeInTheDocument()
    expect(screen.queryByText('Side bets')).not.toBeInTheDocument()
  })

  /**
   * The stroke dots belong to the game the round is ABOUT. A cheap net side bet
   * used to capture them purely by being the first net game in the array.
   */
  it('does not let a net side bet capture the stroke dots', async () => {
    const round = makeRound({
      players: makePlayers([
        { name: 'Ann', ch: 0 },
        { name: 'Bob', ch: 18 },
      ]),
      holes: 'front9',
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
      ],
    })
    round.id = 'round-dots'
    // the MAIN game is gross; the side bet is net and would allocate strokes
    round.games[0]!.handicap = { mode: 'gross', reference: 'offLow', allowancePct: 100 }
    round.games[1]!.handicap = { mode: 'net', reference: 'offLow', allowancePct: 100 }
    await db.rounds.put(round)
    show(round)

    // Bob is off 18, so the NET side bet would put a stroke on every hole. The
    // main game is gross and gives none, so no row reports any.
    //
    // Asserted on ScoreRow's `${strokes} strokes` aria-label, because the
    // visible mark for a received stroke is "■" — an earlier version of this
    // test looked for "+1", which ScoreRow only ever renders for a NEGATIVE
    // stroke count, and so passed under the old first-net-game rule too.
    await screen.findByText('Bob')
    expect(screen.queryByLabelText(/\d+ strokes/)).not.toBeInTheDocument()
  })

  /** The positive control for the test above: the query DOES find strokes. */
  it('shows the dots when the main game is the net one', async () => {
    const round = makeRound({
      players: makePlayers([
        { name: 'Ann', ch: 0 },
        { name: 'Bob', ch: 18 },
      ]),
      holes: 'front9',
      games: [{ type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } }],
    })
    round.id = 'round-dots-net'
    round.games[0]!.handicap = { mode: 'net', reference: 'offLow', allowancePct: 100 }
    await db.rounds.put(round)
    show(round)

    await screen.findByText('Bob')
    expect(screen.getByLabelText(/\d+ strokes/)).toBeInTheDocument()
  })
})

/**
 * MAI-104 / MAI-106. The bar covered the award grid and no gesture reached
 * under it: `<main>` carried a constant `pb-40` (190px) to hold content clear
 * of a `fixed` bar whose real height was 229px with four bets running, so
 * `scrollHeight - innerHeight` was 0 and the last rows were unreachable.
 *
 * MAI-106 then cut the bar to ONE state — the primary game plus a count —
 * because the fold in between was a summary of summaries: more than the recap,
 * still not the accounting, so the reader opened the sheet anyway.
 */
describe('ScoringScreen — the pinned bar', () => {
  /** A nassau main event plus `sideCount` skins side bets. */
  async function roundWith(id: string, sideCount: number) {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
        ...Array.from({ length: sideCount }, (_, i) => ({
          type: 'skins',
          config: { stakeCents: 100 + i, carryover: true },
        })),
      ],
    })
    round.id = id
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: 1, gross: 5 },
    ])
    return round
  }

  const show = (round: { id: string }) => {
    const router = createMemoryRouter(routes, { initialEntries: [`/round/${round.id}`] })
    return render(<RouterProvider router={router} />)
  }

  const bar = () => screen.findByRole('button', { name: /standings/ })

  /**
   * THE RESERVE, as far as jsdom can see it.
   *
   * jsdom has no layout, so there is no honest assertion of the form "the award
   * button is visible". This is a structural proxy, and it is deliberately a
   * PAIR — though not because either half is weak against the SHIPPED bug.
   * Both catch that one: the old bar's className carried `fixed` and the old
   * `main` carried `pb-40`. What the pair guards is the HALF-FIX, which is the
   * likelier future mistake — going sticky while leaving the reserve behind
   * (padding on `main` now lands BELOW the bar and lifts it off the screen
   * edge), or dropping the reserve while the bar stays fixed (straight back to
   * content under an overlay). The two facts are only correct together.
   *
   * What it does NOT catch is the original failure mode itself — a reserve of
   * the wrong SIZE. Nothing in jsdom can, which is exactly why the mechanism
   * changed instead of the number. If the mobile-Safari fallback is ever
   * adopted (keep the bar `fixed`, add a measured spacer with a ResizeObserver),
   * this test is wrong by construction and should be DELETED with the reasoning
   * moved to the spacer, not weakened until it passes.
   */
  it('puts the bar in flow, with no reserve left behind on main', async () => {
    show(await roundWith('round-bar-reserve', 3))
    const el = await bar()

    const strip = el.closest('[data-summary-bar]')!
    // in flow — it reserves its own height by existing
    expect(strip.className).not.toMatch(/\bfixed\b/)
    // …and nothing on main pretends to reserve it a second time
    expect(strip.closest('main')!.className).not.toMatch(/\bpb-/)
  })

  /**
   * ONE STATE: the primary game, and how many more the sheet holds. No fold, no
   * aggregate row, no per-bet "riding" rows — those are the accounting, and the
   * accounting is one tap away.
   */
  it('shows the primary game and a count of the rest', async () => {
    show(await roundWith('round-bar-one-state', 3))
    const el = await bar()

    expect(el).toHaveTextContent('Nassau')
    expect(el).toHaveTextContent('3 more bets')
    // the things MAI-50/MAI-99 used to put here
    expect(el).not.toHaveTextContent('Side bets')
    expect(el).not.toHaveTextContent(/Skins/)
  })

  /**
   * THE COUNT IS OF GAMES, NOT ROWS — and this is a round that tells them apart.
   *
   * Holes 1-5 are played and hole 4 is a par 3 nobody claimed, so the CTP
   * carries; the snake was bitten on 1. That is TWO live positions. The old bar
   * drew one main row + a "Side bets" money aggregate + one riding row EACH, so
   * a row count would say "3 more" for three bets. Verified rather than
   * asserted from the mental model: the derivation really does return two
   * `openBet`s here, which is the only reason this round discriminates.
   *
   * The count is pinned against the SHEET, not a literal, because the number's
   * whole meaning is "how many more bets the sheet will show you" — one panel
   * per game, each with its own rules button.
   */
  it('counts games, not the rows the bar used to draw', async () => {
    const user = userEvent.setup()
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
        { type: 'snake', config: { potCents: 500, doubling: false } },
        { type: 'ctp', config: { stakeCents: 200, carryover: true } },
      ],
    })
    round.id = 'round-bar-count'
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      ...[1, 2, 3, 4, 5].flatMap((hole) => [
        { type: 'score/set' as const, playerId: 'p-ann', hole, gross: 4 },
        { type: 'score/set' as const, playerId: 'p-bob', hole, gross: 5 },
      ]),
      {
        type: 'game/event',
        gameId: round.games[1]!.gameId,
        kind: 'snake/bite',
        data: { hole: 1, playerId: 'p-bob' },
      },
    ])
    show(round)

    // both side bets are carrying a live position, so the old row model would
    // have drawn four rows and said "3 more"
    const el = await bar()
    expect(el).toHaveTextContent('2 more bets')

    // …and 2 is exactly what the sheet goes on to show, beyond the bar's game
    await user.click(el)
    const panels = await screen.findAllByRole('button', { name: /rules/i })
    expect(panels).toHaveLength(3)
  })

  /**
   * THE BAR SHOWS THE PRIMARY GAME, WHICH IS NOT ALWAYS `games[0]`.
   *
   * `primaryGame` prefers the first main game that ALLOCATES STROKES. Here a
   * gross Nassau sits ahead of a net Match Play, so showing `games[0]` would
   * leave the bar saying this round is about Nassau while the scorecard, the
   * stroke dots and the share card all say Match Play. One default primary
   * game, shared by every surface; the bar does not get to be a fourth answer.
   */
  it('shows the primary game rather than the first game', async () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
        { type: 'matchPlay', config: { stakeCents: 500, teams: null } },
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
      ],
    })
    round.id = 'round-bar-primary'
    round.games[0]!.handicap = { mode: 'gross', reference: 'offLow', allowancePct: 100 }
    round.games[1]!.handicap = { mode: 'net', reference: 'offLow', allowancePct: 100 }
    await db.rounds.put(round)
    await eventStore.append(round.id, [
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'score/set', playerId: 'p-bob', hole: 1, gross: 5 },
    ])
    show(round)
    const el = await bar()

    expect(el).toHaveTextContent('Match Play')
    expect(el).not.toHaveTextContent('Nassau')
    expect(el).toHaveTextContent('2 more bets')
  })

  /** Nothing more to show, so the bar says nothing about more. */
  it('says nothing about more bets in a one-game round', async () => {
    show(await roundWith('round-bar-single', 0))
    const el = await bar()

    expect(el).toHaveTextContent('Nassau')
    expect(el).not.toHaveTextContent(/more bet/)
  })

  /** The whole bar is the target — there is no second control on it now. */
  it('opens the standings sheet when tapped', async () => {
    const user = userEvent.setup()
    show(await roundWith('round-bar-tap', 3))

    await user.click(await bar())

    expect(await screen.findByText('View full card ▶')).toBeInTheDocument()
  })

  /**
   * THE SHEET LEADS WITH WHERE EVERYONE STANDS.
   *
   * It used to open straight into a per-bet breakdown, so the first question
   * anyone opening it has — am I up or down? — could only be answered by adding
   * the games up in your head. The section is shared with the settle screen and
   * the share card (`src/lib/standings.ts`), so the number read on the 7th green
   * is the number settled on at the end.
   */
  it('leads the sheet with a combined total, before the per-bet breakdown', async () => {
    const user = userEvent.setup()
    show(await roundWith('round-sheet-total', 3))

    await user.click(await bar())

    const total = await screen.findByRole('heading', { name: 'Total' })
    // three skins at $1, $1.01 and $1.02, all won by Ann on hole 1; the nassau
    // has not settled, so it contributes nothing yet
    const section = total.closest('section')!
    expect(within(section).getByText('Ann')).toBeInTheDocument()
    expect(within(section).getByText('+$3.03')).toBeInTheDocument()
    expect(within(section).getByText('-$3.03')).toBeInTheDocument()

    // …and it comes BEFORE the first game's block, which is the whole point
    const firstGame = screen.getByRole('heading', { name: 'Nassau' })
    expect(total.compareDocumentPosition(firstGame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  /**
   * With one bet the total IS the player cards in the block immediately below —
   * the same rule the bar's count follows. Do not say it twice.
   */
  it('omits the total when there is only one bet to total', async () => {
    const user = userEvent.setup()
    show(await roundWith('round-sheet-total-single', 0))

    await user.click(await bar())

    expect(await screen.findByText('View full card ▶')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Total' })).not.toBeInTheDocument()
  })

  /** With every hole scored the bar is the Finish button, not a recap. */
  it('becomes the Finish button once every hole is scored', async () => {
    const round = await roundWith('round-bar-finished', 3)
    await eventStore.append(
      round.id,
      [2, 3, 4, 5, 6, 7, 8, 9].flatMap((hole) => [
        { type: 'score/set' as const, playerId: 'p-ann', hole, gross: 4 },
        { type: 'score/set' as const, playerId: 'p-bob', hole, gross: 5 },
      ]),
    )
    show(round)

    expect(await screen.findByRole('button', { name: /Finish round/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /standings/ })).not.toBeInTheDocument()
  })
})
