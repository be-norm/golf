import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import type { Course } from '../../engine/core/types'
import { db } from '../../db/schema'
import { LOCAL_USER } from '../../db/ids'
import { routes } from '../../app/routes'
import { roleOf } from '../../engine/catalog'

const SAVED_AT = '2026-08-01T00:00:00.000Z'

/**
 * Penmar exactly as OpenGolfAPI serves it: 9 holes, par 33, slope 103, and NO
 * published course rating (so `rating` falls back to par and the (rating − par)
 * term drops out). This is the round that shipped 15 strokes to a 16.5 index.
 */
const penmar: Course = {
  id: 'penmar',
  name: 'Penmar Golf Course',
  location: 'Venice, CA',
  holeCount: 9,
  holes: [4, 4, 3, 4, 3, 4, 4, 4, 3].map((par, i) => ({
    number: i + 1,
    par,
    strokeIndex: [6, 2, 8, 4, 9, 1, 5, 3, 7][i]!,
  })),
  teeSets: [{ id: 'tee-0-blue', name: 'Blue', rating: 33, slope: 103 }],
  source: 'remote',
  updatedAt: '2026-07-22T00:00:00.000Z',
  revision: 0,
}

/** A plain 18-hole course, to check the hole range resets when courses switch. */
const eighteen: Course = {
  id: 'eighteen',
  name: 'Wood Wind',
  location: 'Westfield, IN',
  holeCount: 18,
  holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndex: i + 1 })),
  teeSets: [{ id: 'tee-white', name: 'White', rating: 70, slope: 120 }],
  source: 'remote',
  updatedAt: '2026-07-22T00:00:00.000Z',
  revision: 0,
}

/** Step 0: land on setup and pick Penmar (which auto-selects its only tee). */
async function pickPenmar() {
  await db.courses.put(penmar)
  // the picker lists the SIGNED-IN USER's library, so a seeded card needs
  // membership too — course data is shared, keeping it is owned (MAI-76)
  await db.saved_courses.put({ userId: LOCAL_USER, courseId: penmar.id, updatedAt: SAVED_AT })
  const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
  render(<RouterProvider router={router} />)
  await userEvent.click(await screen.findByText('Penmar Golf Course'))
}

/** Step 1: add a player and give them a handicap index. */
async function addPlayer(name: string, index: number) {
  await userEvent.type(screen.getByPlaceholderText('Player name'), name)
  await userEvent.click(screen.getByRole('button', { name: 'Add' }))
  fireEvent.change(await screen.findByLabelText(`${name} handicap index`), {
    target: { value: String(index) },
  })
}

const cont = () => userEvent.click(screen.getByRole('button', { name: 'Continue' }))

/**
 * Step 2 lists only what has been CHOSEN, so games are added through the picker
 * sheet. It auto-opens the first time step 2 is reached empty, which is why the
 * older tests below can still click a game name straight after `cont()`.
 */
async function pickGame(name: string, section: 'main' | 'side' = 'main') {
  if (section === 'side') {
    await userEvent.click(screen.getByRole('button', { name: /Add a side bet|More side bets/ }))
  } else if (screen.queryByRole('button', { name: /Choose a game|Add another game/ })) {
    await userEvent.click(screen.getByRole('button', { name: /Choose a game|Add another game/ }))
  }
  // Scoped to the sheet: a chosen game shows the SAME name on the page behind
  // it, so an unscoped query goes ambiguous the moment one is added.
  await userEvent.click(await within(await picker()).findByText(name))
}

/** The picker sheet's content region. */
const picker = () => screen.findByRole('region', { name: 'Game picker' })
const pickerClosed = () =>
  expect(screen.queryByRole('region', { name: 'Game picker' })).not.toBeInTheDocument()

/** Two players and a game, from a standing start. */
async function toStepTwo() {
  await pickPenmar()
  await cont()
  await addPlayer('Bogey', 16.5)
  await addPlayer('Scratch', 0)
  await cont()
}

const teeOff = () => userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

const roundFor = async (courseId: string) =>
  (await db.rounds.toArray()).find((r) => r.courseId === courseId)

/**
 * Every test here drives the whole wizard and tees off, and `fake-indexeddb`
 * persists for the lifetime of the FILE — so without this, a test asserting on
 * "the round" reads whichever one a previous test left behind.
 *
 * That is not hypothetical: `leaves role unstamped` used to assert
 * `rounds.count() === 1` inside a `waitFor`, which the PREVIOUS test's round
 * satisfied on the first poll, before this test's own write landed. It then
 * read `toArray()[0]` — the other test's round — and passed without ever
 * looking at what it had built. Clearing per test removes the whole class,
 * rather than teaching each assertion to identify its own round.
 */
beforeEach(async () => {
  await db.rounds.clear()
  await db.players.clear()
})

describe('SetupScreen — 9-hole courses', () => {
  it('gives a nine HALF the index: 16.5 → HCP 8, not 15', async () => {
    await pickPenmar()
    // a 9-hole course defaults to its nine and says what that does to handicaps
    expect(screen.getByText(/half your index/)).toBeInTheDocument()

    await cont()
    await addPlayer('Bogey', 16.5)

    // (16.5 ÷ 2) × (103/113) + (33 − 33) = 7.52 → 8. The bug gave 15.
    expect(await screen.findByText('HCP 8')).toBeInTheDocument()
  })

  it('gives the FULL index when the nine is played twice around', async () => {
    await pickPenmar()
    await userEvent.click(screen.getByRole('button', { name: '18 (twice around)' }))
    expect(screen.getByText(/full 18-hole handicaps/)).toBeInTheDocument()

    await cont()
    await addPlayer('Bogey', 16.5)

    // two loops → rating 66 against par 66: 16.5 × (103/113) = 15.04 → 15
    expect(await screen.findByText('HCP 15')).toBeInTheDocument()
  })

  it('freezes a doubled 18-hole snapshot at tee-off, leaving the library course a nine', async () => {
    await pickPenmar()
    await userEvent.click(screen.getByRole('button', { name: '18 (twice around)' }))
    await cont()
    await addPlayer('Bogey', 16.5)
    await addPlayer('Scratch', 0)
    await cont()

    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    await waitFor(async () => expect(await db.rounds.count()).toBe(1))
    const round = (await db.rounds.toArray())[0]!
    expect(round.holes).toBe('full18')
    expect(round.courseSnapshot.holeCount).toBe(18)
    expect(round.courseSnapshot.holes).toHaveLength(18)
    // second loop replays the same holes, on the even stroke indexes
    expect(round.courseSnapshot.holes[14]!.par).toBe(round.courseSnapshot.holes[5]!.par)
    expect(round.courseSnapshot.holes[5]!.strokeIndex).toBe(1)
    expect(round.courseSnapshot.holes[14]!.strokeIndex).toBe(2)
    expect(round.players.find((p) => p.name === 'Bogey')!.courseHandicap).toBe(15)
    // the library course itself is untouched — still the nine it is
    expect(round.courseId).toBe('penmar')
    expect((await db.courses.get('penmar'))!.holeCount).toBe(9)
  })

  /**
   * Setup writes NO `role`. Whether an "either" game is this round's main event
   * or its side bet depends on what else is in the round, so a per-game guess
   * frozen here would be permanently wrong in a synced archive — `roleOf`
   * derives it instead (see catalog.test.ts for the rule itself).
   */
  it('leaves role unstamped, for roleOf to derive', async () => {
    await pickPenmar()
    await cont()
    await addPlayer('Bogey', 16.5)
    await addPlayer('Scratch', 0)
    await cont()

    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    await waitFor(async () => expect(await db.rounds.count()).toBe(1))
    const round = (await db.rounds.toArray())[0]!
    expect(round.games).toHaveLength(1)
    expect(round.games[0]!.role).toBeUndefined()
  })

  it('resets the hole range when switching from a nine to an eighteen', async () => {
    await db.courses.bulkPut([penmar, eighteen])
    await db.saved_courses.bulkPut([
      { userId: LOCAL_USER, courseId: penmar.id, updatedAt: SAVED_AT },
      { userId: LOCAL_USER, courseId: eighteen.id, updatedAt: SAVED_AT },
    ])
    const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
    render(<RouterProvider router={router} />)

    // pick the nine (defaults to its 9-hole range), then switch to the eighteen
    await userEvent.click(await screen.findByText('Penmar Golf Course'))
    await userEvent.click(screen.getByText('Wood Wind'))
    await cont() // course → players

    // the eighteen must default to the full round, not inherit the nine's front9
    await addPlayer('Bogey', 10.4)
    await addPlayer('Scratch', 0)
    await cont() // players → games
    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    // (other tests in this file also tee off, so key on this round's course)
    const forEighteen = async () =>
      (await db.rounds.toArray()).find((r) => r.courseId === 'eighteen')
    await waitFor(async () => expect(await forEighteen()).toBeDefined())
    expect((await forEighteen())!.holes).toBe('full18')
  })

  it('halves the strokes when only the front 9 of an 18-hole course is played', async () => {
    await db.courses.put(eighteen)
    await db.saved_courses.put({ userId: LOCAL_USER, courseId: eighteen.id, updatedAt: SAVED_AT })
    const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
    render(<RouterProvider router={router} />)

    await userEvent.click(await screen.findByText('Wood Wind'))
    // an 18-hole course, cut to the front 9
    await userEvent.click(screen.getByRole('button', { name: 'Front 9' }))
    expect(screen.getByText(/plays off half their course handicap/)).toBeInTheDocument()

    await cont() // course → players
    // rating 70 / slope 120 / par 72: index 21 → CH round(20.30)=20 (the FULL
    // 18-hole handicap); index 2 → CH 0, the low.
    await addPlayer('Bogey', 21)
    await addPlayer('Scratch', 2)
    // the chip shows the full course handicap, not the per-round halving
    expect(await screen.findByText('HCP 20')).toBeInTheDocument()

    await cont() // players → games
    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    // First Tee: CH still reads 20, but only 9 holes are played, so the strokes
    // are halved — round(20/2)=10, spread over the front-nine stroke indexes.
    expect(await screen.findByText('★ First tee ★')).toBeInTheDocument()
    expect(strokeRow('Bogey')).toHaveTextContent('CH 20 · 10 strokes')
    expect(strokeRow('Scratch')).toHaveTextContent('CH 0 · 0 strokes')
  })
})

/**
 * MAI-44. Step 2 used to render every registered engine as a full-width card,
 * keyed by `engine.type` — fine at five games, unusable at twenty-five, and it
 * capped a round at one instance per game.
 */
describe('SetupScreen — choosing games', () => {
  it('auto-opens the picker on the first empty visit, and not again after that', async () => {
    await toStepTwo()

    // arrived empty → the sheet is already open, which is the entry point
    expect(await picker()).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(pickerClosed)
    expect(screen.getByText('Nothing picked yet')).toBeInTheDocument()

    // Back to step 1 and forward again — still empty, and it must STAY closed.
    // Re-opening whenever step 2 is empty traps the user, because empty is
    // exactly the state you are in while trying to go back.
    await userEvent.click(screen.getByText('← Back'))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Nothing picked yet')).toBeInTheDocument()
    await waitFor(pickerClosed)
  })

  /**
   * The round `gameLabel`'s whole discriminator ladder exists to name, and
   * which was unreachable from this screen until drafts got instance ids.
   */
  it('adds two instances of one game, configured independently', async () => {
    await toStepTwo()
    await pickGame('Skins')
    await pickGame('Skins', 'side')

    // make them differ, or they are a duplicate and tee-off is blocked. Only
    // the main card's stake is mounted — the side row is collapsed.
    await userEvent.click(screen.getByRole('button', { name: 'increase Skin value' }))

    await teeOff()
    await waitFor(async () => expect(await roundFor('penmar')).toBeDefined())
    const round = (await roundFor('penmar'))!
    expect(round.games).toHaveLength(2)
    expect(round.games[0]!.gameId).not.toBe(round.games[1]!.gameId)
    expect(round.games.every((g) => g.type === 'skins')).toBe(true)
    // and they really are different games, not one config written twice
    expect(round.games[0]!.config).not.toEqual(round.games[1]!.config)
  })

  /**
   * The teed-off round must DERIVE the sections the user picked, for every
   * game — not just the one that was added last.
   *
   * Deriving each draft against the role-stripped set got this wrong in the
   * most ordinary way there is: two side bets and no main game. It stamped the
   * first Skins 'side', which made `roleOf` skip it when hunting for the first
   * unclaimed "either" game — so the SECOND one silently became the round's
   * main event, and took the stroke dots, the scorecard underlines and the
   * share card's stroke note with it.
   */
  it('derives every section it was given, not just the last game added', async () => {
    await toStepTwo()
    await pickGame('Skins', 'side')
    await pickGame('Skins', 'side')
    // a side-bet row is collapsed until tapped, so open one to reach its stake
    // and make the two differ (identical settings block tee-off)
    await userEvent.click(screen.getAllByRole('button', { expanded: false })[0]!)
    await userEvent.click(screen.getByRole('button', { name: 'increase Skin value' }))

    await teeOff()
    await waitFor(async () => expect(await roundFor('penmar')).toBeDefined())
    const round = (await roundFor('penmar'))!
    expect(round.games).toHaveLength(2)
    // both were picked as side bets, so both must READ as side bets
    for (const game of round.games) {
      expect(roleOf(game, round.games)).toBe('side')
    }
  })

  it('blocks tee-off on two identical instances, and says so once', async () => {
    await toStepTwo()
    await pickGame('Skins')
    await pickGame('Skins', 'side')

    const problem = await screen.findByText(/identical settings/)
    expect(problem).toBeInTheDocument()
    // ONE message, not one per instance — both report it and the caller dedupes
    expect(screen.getAllByText(/identical settings/)).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Tee off/ })).toBeDisabled()
  })

  /**
   * Layout follows the button you pressed, not `roleOf`. A lone Skins IS the
   * round's main event by derivation — which is true, and still reads as the
   * screen ignoring you when you just tapped "+ Add a side bet".
   */
  it('keeps a game in the section it was picked into', async () => {
    await toStepTwo()
    await pickGame('Skins', 'side')

    expect(screen.getByText('Nothing picked yet')).toBeInTheDocument()
    // it sits under SIDE BETS, as a compact row rather than a full card
    expect(screen.getByRole('button', { name: 'remove Skins' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /More side bets/ })).toBeInTheDocument()
  })

  it('tees off a side-bets-only round, storing no role for it', async () => {
    await toStepTwo()
    await pickGame('Skins', 'side')

    await teeOff()
    await waitFor(async () => expect(await roundFor('penmar')).toBeDefined())
    const round = (await roundFor('penmar'))!
    expect(round.games).toHaveLength(1)
    // Nothing READS the distinction in a one-game round — `primaryGame` returns
    // this game either way, the bar doesn't collapse a lone side bet and the
    // card doesn't group one — so storing 'side' would freeze a value with no
    // consumer into a synced archive.
    expect(round.games[0]!.role).toBeUndefined()
  })

  /**
   * The one placement that DOES have a reader: a main-game Skins beside a
   * Nassau. `roleOf` would derive 'side' (Nassau can only be the main event),
   * so the user's choice has to be recorded or it is lost.
   */
  it('stores role only when the chosen section contradicts roleOf', async () => {
    await pickPenmar()
    await cont()
    await addPlayer('Bogey', 16.5)
    await addPlayer('Scratch', 0)
    await cont()

    await pickGame('Nassau')
    await pickGame('Skins')

    await teeOff()
    await waitFor(async () => expect(await roundFor('penmar')).toBeDefined())
    const round = (await roundFor('penmar'))!
    const nassau = round.games.find((g) => g.type === 'nassau')!
    const skins = round.games.find((g) => g.type === 'skins')!
    // nassau is 'main' by category, so nothing to record
    expect(nassau.role).toBeUndefined()
    expect(skins.role).toBe('main')
  })

  it('offers a threesome game to three players and hides the foursome ones', async () => {
    await pickPenmar()
    await cont()
    await addPlayer('A', 10)
    await addPlayer('B', 10)
    await addPlayer('C', 10)
    await cont()

    // the "who plays whom" view is roster-aware: it answers what this group
    // could actually play, so it filters rather than dims
    const sheet = within(await picker())
    await userEvent.click(sheet.getByRole('button', { name: 'By who plays whom' }))
    // Nassau appears under BOTH its shapes (1v1 and 2v2) — `shapes` is a set
    // precisely because that is true of it, so more than one hit is correct.
    expect(sheet.getAllByText('Nassau').length).toBeGreaterThan(0)
    expect(sheet.getByText('Six Point')).toBeInTheDocument()
    expect(sheet.queryByText('Vegas')).not.toBeInTheDocument()
    expect(sheet.queryByText('Wolf')).not.toBeInTheDocument()
    // hidden is not absent — say what the roster filtered out
    expect(sheet.getByText(/need a different group size/)).toBeInTheDocument()
  })

  it('keeps an unplayable game visible in the by-type view, with the reason', async () => {
    await toStepTwo() // two players
    const sheet = within(await picker())
    expect(sheet.getByText('Vegas')).toBeInTheDocument()
    // Vegas and Wolf both need exactly four, so both say so
    expect(sheet.getAllByText('Needs 4 players').length).toBeGreaterThan(0)
  })
})

/** A player's per-GAME stroke row on the First Tee screen — the editable
 *  handicap list above it lists the same names, so match the row that reports
 *  strokes. (Mirrors the helper in roundStart.test.tsx.) */
function strokeRow(name: string): HTMLElement {
  const row = screen
    .getAllByText(name)
    .map((el) => el.closest('li'))
    .find((li) => li?.textContent?.includes('strokes'))
  if (!row) throw new Error(`no stroke row for ${name}`)
  return row
}
