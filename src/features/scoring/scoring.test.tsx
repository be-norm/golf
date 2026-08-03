import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { makeCourse, makePlayers, makeRound } from '../../engine/test/harness'
import { doubleNine } from '../../engine/core/tees'
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
    expect(await screen.findByText(/every bet is level/)).toBeInTheDocument()
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
