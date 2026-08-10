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
 * fake-indexeddb is one store for the whole FILE, and several of these tests
 * tee off. Without this the rounds pile up and any test asserting "exactly one
 * round" fails depending on which of its neighbours got there first — a real
 * ~60%-of-runs flake when the file is run on its own.
 */
beforeEach(async () => {
  // every table, not a hand-picked list: clearing `rounds` while leaving
  // `round_events` behind orphans each teed-off round's log and reintroduces
  // the same leak in a form that's harder to see
  await Promise.all(db.tables.map((t) => t.clear()))
})

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

/** Land on setup and pick Penmar. Picking a course auto-selects its first tee
 *  and moves to the tee/holes step, so this leaves us on step 1. */
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
 * The games step lists only what has been CHOSEN, so games are added through
 * the picker sheet. It auto-opens the first time that step is reached empty,
 * which is why the older tests below can still click a game name straight
 * after the last `cont()`.
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

/**
 * Two players and a game, from a standing start. `pickPenmar` lands on the tee
 * step, so this is course → tees → players → games (MAI-79 split the course
 * choice out of the tee screen).
 */
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

describe('SetupScreen — picking the course is its own step', () => {
  it('leaves the course list behind once a course is chosen', async () => {
    // Choosing tees underneath a list of every OTHER course read as though the
    // list were still the question being asked.
    await db.courses.bulkPut([penmar, eighteen])
    await db.saved_courses.bulkPut([
      { userId: LOCAL_USER, courseId: penmar.id, updatedAt: SAVED_AT },
      { userId: LOCAL_USER, courseId: eighteen.id, updatedAt: SAVED_AT },
    ])
    const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
    render(<RouterProvider router={router} />)

    // step 0 — every course, and no tees
    expect(await screen.findByText('Wood Wind')).toBeInTheDocument()
    expect(screen.queryByText('Tees')).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('Penmar Golf Course'))

    // step 1 — the chosen course, its tees, and none of the others
    expect(await screen.findByText('Tees')).toBeInTheDocument()
    expect(screen.getByText('Holes')).toBeInTheDocument()
    expect(screen.queryByText('Wood Wind')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Scan scorecard/i })).not.toBeInTheDocument()
    // and it says which course these tees belong to
    expect(screen.getByText('Penmar Golf Course')).toBeInTheDocument()
  })

  it('keeps the tees and hole range when you go back and re-tap the same course', async () => {
    // Re-tapping the already-highlighted course is navigation, not a fresh
    // choice. Resetting there would discard a hole range chosen on a screen the
    // user can no longer see — cause and effect two steps apart.
    await pickPenmar()
    await userEvent.click(screen.getByRole('button', { name: '18 (twice around)' }))
    expect(screen.getByText(/full 18-hole handicaps/)).toBeInTheDocument()

    await userEvent.click(screen.getByText('← Back'))
    await userEvent.click(await screen.findByText('Penmar Golf Course'))

    expect(await screen.findByText(/full 18-hole handicaps/)).toBeInTheDocument()
  })

  it('goes back to the course list to change your mind', async () => {
    await pickPenmar()
    expect(await screen.findByText('Tees')).toBeInTheDocument()

    await userEvent.click(screen.getByText('← Back'))

    expect(await screen.findByText('Where are you playing?')).toBeInTheDocument()
    expect(screen.queryByText('Tees')).not.toBeInTheDocument()
  })
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

    // pick the nine (defaults to its 9-hole range), then go back and switch to
    // the eighteen — changing your mind is what Back is for now that the course
    // list isn't sharing a screen with the tees
    await userEvent.click(await screen.findByText('Penmar Golf Course'))
    await userEvent.click(screen.getByText('← Back'))
    await userEvent.click(screen.getByText('Wood Wind'))
    await cont() // tees/holes → players

    // the eighteen must default to the full round, not inherit the nine's front9
    await addPlayer('Bogey', 10.4)
    await addPlayer('Scratch', 0)
    await cont() // players → games
    await userEvent.click(await screen.findByText('Skins'))
    await userEvent.click(screen.getByRole('button', { name: /Tee off/ }))

    await waitFor(async () => expect(await db.rounds.count()).toBe(1))
    const round = (await db.rounds.toArray())[0]!
    expect(round.courseId).toBe('eighteen')
    expect(round.holes).toBe('full18')
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

    await cont() // tees/holes → players
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
  /**
   * MAI-79 renumbered the steps (course/tees/players/games), so the effect that
   * opens the picker had to move with them. Keyed on the old bare `2` it would
   * fire on the PLAYERS step — a screen with no games section to open onto.
   */
  it('does not open the picker before the games step', async () => {
    await pickPenmar()
    await cont() // → players
    expect(screen.queryByRole('region', { name: 'Game picker' })).not.toBeInTheDocument()
    await addPlayer('Bogey', 16.5)
    await addPlayer('Scratch', 0)
    expect(screen.queryByRole('region', { name: 'Game picker' })).not.toBeInTheDocument()
    await cont() // → games
    expect(await picker()).toBeInTheDocument()
  })

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
    await userEvent.click(screen.getByRole('button', { name: /^increase Skin value/ }))

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
    await userEvent.click(screen.getByRole('button', { name: /^increase Skin value/ }))

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

  /**
   * Removing a player left their draft id in Nassau's `teams`, where nothing
   * renders it — so the screen showed three players each on exactly one side
   * while reporting "every player must be on exactly one nassau side" about a
   * fourth nobody could see. Correct, and impossible to act on.
   */
  it('drops a removed player out of the teams they were on', async () => {
    await pickPenmar()
    await cont() // → players
    for (const name of ['Ann', 'Ben', 'Cal', 'Dee']) await addPlayer(name, 10)
    await cont() // → games
    await pickGame('Nassau')
    // four players: Nassau seeds a 2v2, so every id is spoken for
    expect(screen.queryByText(/exactly one nassau side/)).not.toBeInTheDocument()

    // back to the roster, drop one, and return
    await userEvent.click(screen.getByText('← Back'))
    await userEvent.click(await screen.findByRole('button', { name: 'remove Dee' }))
    await cont()

    // 2v1 is a legal Nassau, so there is nothing left to complain about
    expect(screen.queryByText(/exactly one nassau side/)).not.toBeInTheDocument()
    await teeOff()
    await waitFor(async () => expect(await roundFor('penmar')).toBeDefined())
    const { teams } = (await roundFor('penmar'))!.games[0]!.config as {
      teams: { a: string[]; b: string[] }
    }
    // three real player ids, and no ghost
    expect([...teams.a, ...teams.b]).toHaveLength(3)
    expect(teams.a.length).toBeGreaterThan(0)
    expect(teams.b.length).toBeGreaterThan(0)
  })

  /**
   * MAI-90. A round counts putts because a game in it READS putts — the group
   * is never offered the choice. Offering it was the first design and it was
   * wrong: nothing in this app shows putts back to you, so a Skins round was
   * being asked for a number that went into the log and was never seen again.
   *
   * The negative is the one that matters, because it is every round played
   * today: no shipped engine reads putts, so nothing about them should appear
   * anywhere in setup.
   */
  it('says nothing about putts when no chosen game needs them', async () => {
    await pickPenmar()
    await cont()
    await addPlayer('Ann', 10)
    await addPlayer('Bo', 10)
    await cont()
    await pickGame('Skins')

    expect(screen.queryByText(/putts/i)).not.toBeInTheDocument()

    await teeOff()
    await waitFor(async () => expect(await roundFor('penmar')).toBeDefined())
    // and the round is byte-identical to one created before any of this existed
    expect((await roundFor('penmar'))!.trackPutts).toBeUndefined()
  })

  /**
   * Starting hole — the picker, the stamp, and the rule that keeps MAI-41
   * revertible.
   */
  describe('starting hole', () => {
    /** an 18-hole course, through the tee step, ready for the hole controls */
    async function toTeeStep() {
      await db.courses.put(eighteen)
      await db.saved_courses.put({ userId: LOCAL_USER, courseId: eighteen.id, updatedAt: SAVED_AT })
      const router = createMemoryRouter(routes, { initialEntries: ['/setup'] })
      render(<RouterProvider router={router} />)
      await userEvent.click(await screen.findByText('Wood Wind'))
    }

    /** finish a round off the tee step, so the stored shape can be read back */
    async function finish() {
      await cont()
      await addPlayer('Bogey', 16.5)
      await addPlayer('Scratch', 0)
      await cont()
      await pickGame('Skins')
      await teeOff()
      await waitFor(async () => expect(await roundFor('eighteen')).toBeDefined())
      return (await roundFor('eighteen'))!
    }

    it('wraps the round from the hole you picked, and says so before you tee off', async () => {
      await toTeeStep()
      await userEvent.click(screen.getByRole('button', { name: '10' }))
      expect(screen.getByText("You'll play 10–18, 1–9.")).toBeInTheDocument()

      const round = await finish()
      expect(round.startHole).toBe(10)
    })

    /**
     * The byte-identical promise, and the same assertion `trackPutts` gets
     * above: a round teeing off where its range already starts stores NOTHING,
     * so it is indistinguishable from every round created before MAI-41.
     */
    it('stores no start hole at all when the round tees off where the range says', async () => {
      await toTeeStep()
      // hole 1 is already selected; tapping it changes nothing
      await userEvent.click(screen.getByRole('button', { name: '1' }))
      expect(screen.queryByText(/You'll play/)).not.toBeInTheDocument()

      expect((await finish()).startHole).toBeUndefined()
    })

    /**
     * A NINE STARTS INSIDE ITS OWN NINE, which is what keeps its name honest —
     * and, because a rotation can never leave the range's block, keeps every
     * round revertible: reverting MAI-41 restores the same hole SET, with every
     * score still sitting on a hole the round plays.
     *
     * Unbounded, this is where it would break: a `front9` carrying
     * `startHole: 10` would come back from a revert as holes 1–9 against scores
     * posted on 10–18, an empty card in a synced archive.
     */
    it('starts a back nine anywhere in the back nine, and wraps within it', async () => {
      await toTeeStep()
      await userEvent.click(screen.getByRole('button', { name: 'Back 9' }))
      await userEvent.click(screen.getByRole('button', { name: '13' }))
      expect(screen.getByText("You'll play 13–18, 10–12.")).toBeInTheDocument()

      const round = await finish()
      expect(round.holes).toBe('back9')
      expect(round.startHole).toBe(13)
    })

    it('offers a nine only its own holes — never the other nine', async () => {
      await toTeeStep()
      await userEvent.click(screen.getByRole('button', { name: 'Back 9' }))
      expect(screen.getByRole('button', { name: '10' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '18' })).toBeInTheDocument()
      // a front-nine hole is not on the board at all
      expect(screen.queryByRole('button', { name: '4' })).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: 'Front 9' }))
      expect(screen.getByRole('button', { name: '4' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '13' })).not.toBeInTheDocument()
    })

    /**
     * Changing the range re-heads the start. `playedStart` would correct a
     * stale 14 anyway, but leaving the raw state behind means tapping back to
     * 18 holes silently restores a hole chosen two taps ago — and stamps it.
     */
    it('re-heads the start when the range changes, and stores nothing', async () => {
      await toTeeStep()
      await userEvent.click(screen.getByRole('button', { name: '14' }))
      await userEvent.click(screen.getByRole('button', { name: 'Front 9' }))
      expect(screen.queryByText(/You'll play/)).not.toBeInTheDocument()

      const round = await finish()
      expect(round.holes).toBe('front9')
      expect(round.startHole).toBeUndefined()
    })

    /**
     * A nine played twice around already renumbers the card 1–18 and stamps
     * which loop each number is, so an offset on top would label the closing
     * holes "1st time round" when they were the second. Its own NINE has no
     * loop stamps, so that one chooses freely. Penmar is the nine.
     */
    it('offers a nine-hole card its own nine, but not two loops of it', async () => {
      await pickPenmar()
      expect(screen.getByText('Start on hole')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '7' })).toBeInTheDocument()
      // …and nothing beyond the nine that exists
      expect(screen.queryByRole('button', { name: '13' })).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: '18 (twice around)' }))
      expect(screen.queryByText('Start on hole')).not.toBeInTheDocument()
    })
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
