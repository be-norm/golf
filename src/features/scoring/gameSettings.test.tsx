import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import '../../engine/games'
import { makePlayers, makeRound } from '../../engine/test/harness'
import { db } from '../../db/schema'
import { eventStore } from '../../db/eventStore'
import { routes } from '../../app/routes'
import type { Round } from '../../engine/core/types'

/**
 * THE SETTINGS EDITOR (MAI-100/101).
 *
 * The case it exists for: a group played Snake at $1 with doubling off, noticed
 * on the ninth green, and had no way to fix it short of abandoning the round.
 * Saving here appends a `game/configured` amendment, which re-prices the WHOLE
 * round — so these tests care as much about what is NOT written as what is.
 */

const renderStart = (roundId: string) =>
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { initialEntries: [`/round/${roundId}/start`] })}
    />,
  )

let seq = 0
async function seed(games: Round['games'], events: Parameters<typeof eventStore.append>[1] = []) {
  const round = makeRound({
    players: makePlayers([{ name: 'Ann' }, { name: 'Bo' }, { name: 'Cal' }, { name: 'Dee' }]),
    holes: 'front9',
    games: games.map((g) => ({ type: g.type, config: g.config, handicap: g.handicap })),
  })
  round.id = `round-settings-${++seq}`
  await db.rounds.put(round)
  if (events.length > 0) await eventStore.append(round.id, events)
  return round.id
}

const snakeGames = (): Round['games'] => [
  {
    gameId: 'game-1',
    type: 'snake',
    handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
    config: { potCents: 100, doubling: false },
  },
]

/** Open the sheet for the first game on the screen. */
async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: /settings$/i }))
  return screen.findByRole('button', { name: 'Save' })
}

const amendments = async (roundId: string) =>
  (await eventStore.list(roundId)).filter((e) => e.type === 'game/configured')

describe('GameSettingsSheet', () => {
  /**
   * The reported round, fixed. The stepper writes ONE amendment carrying the
   * whole settings object — not a patch, and not one event per tap.
   */
  it('saves a stake change as a single amendment', async () => {
    const roundId = await seed(snakeGames(), [
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
    ])
    renderStart(roundId)
    const save = await openEditor()

    fireEvent.click(screen.getByRole('button', { name: /increase Pot/i }))
    fireEvent.click(save)

    await waitFor(async () => expect(await amendments(roundId)).toHaveLength(1))
    const [amendment] = await amendments(roundId)
    expect(amendment).toMatchObject({
      type: 'game/configured',
      gameId: 'game-1',
      // the WHOLE config, so `amendRound` never has to merge
      config: { potCents: 125, doubling: false },
      handicap: { mode: 'gross' },
    })
  })

  /**
   * AND SAVING AN UNCHANGED FORM WRITES NOTHING. The log is append-only and it
   * syncs and exports, so a no-op amendment would outlive the round in every
   * copy of it — the same rule the scoring screen's input channel follows
   * ("re-picking what is already in effect must write nothing").
   */
  it('writes nothing when nothing changed', async () => {
    const roundId = await seed(snakeGames())
    renderStart(roundId)
    fireEvent.click(await openEditor())

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
    expect(await amendments(roundId)).toHaveLength(0)
  })

  /**
   * WHAT IT DOES TO THE MONEY, before it is written. An amendment re-prices
   * holes that are already settled and already read out — correct, and alarming,
   * so the number is stated rather than left for the group to spot on the bar.
   *
   * Skins rather than Snake, deliberately: Snake settles ONLY on a completed
   * round, and a completed round is read-only here, so its honest mid-round
   * swing is always zero. A bet that pays hole by hole is the ordinary case.
   */
  it('states the swing over holes already played', async () => {
    const roundId = await seed(
      [
        {
          gameId: 'game-1',
          type: 'skins',
          handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
          config: { stakeCents: 100, carryover: true },
        },
      ],
      // Ann wins hole 1 outright: +$3 from the other three, so the money on
      // screen is real before anything is edited
      [
        { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 3 },
        { type: 'score/set', playerId: 'p-bo', hole: 1, gross: 4 },
        { type: 'score/set', playerId: 'p-cal', hole: 1, gross: 4 },
        { type: 'score/set', playerId: 'p-dee', hole: 1, gross: 4 },
      ],
    )
    renderStart(roundId)
    await openEditor()

    // $1 → $1.25 a skin: Ann collects 25c more from each of three others
    fireEvent.click(screen.getByRole('button', { name: /increase Skin value/i }))
    expect(await screen.findByText(/Re-prices the round/i)).toBeInTheDocument()
    expect(await screen.findByText(/Ann \+\$0\.75/)).toBeInTheDocument()
    expect(screen.getByText(/Bo -\$0\.25/)).toBeInTheDocument()
  })

  /**
   * A BET THAT HASN'T SETTLED STILL CHANGED, and the preview has to say so.
   *
   * Snake pays only on a completed round, so mid-round its settlement swing is
   * genuinely zero — and reporting only the swing said "No change to the money"
   * about the very edit just made, which reads as "that did nothing". This was
   * found smoke-testing the reported case, not by a test, because it is a
   * sentence rather than a number.
   *
   * `openBet` is the channel for it ("a live bet the money cannot show yet"),
   * so the preview asks the same one the pinned bar does.
   */
  it('states what is riding when a bet has not settled yet', async () => {
    const roundId = await seed(snakeGames(), [
      ...[1, 2, 3].flatMap((hole) =>
        ['p-ann', 'p-bo', 'p-cal', 'p-dee'].map((playerId) => ({
          type: 'score/set' as const,
          playerId,
          hole,
          gross: 4,
        })),
      ),
      { type: 'game/event', gameId: 'game-1', kind: 'snake/bite', data: { hole: 2, playerId: 'p-ann' } },
    ])
    renderStart(roundId)
    await openEditor()

    fireEvent.click(screen.getByRole('button', { name: /increase Pot/i }))
    // Ann is carrying it at the new pot against three others — not "no change"
    expect(await screen.findByText(/Riding: Ann · -\$1\.25 x 3/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing settled yet/)).toBeNull()
    expect(screen.queryByText(/unchanged/)).toBeNull()
  })

  /**
   * THE POSITION IS REPORTED EVEN WHEN THE CHANGE DOESN'T MOVE IT, because it
   * can land in the same place by arithmetic and a silent panel then reads as
   * "that did nothing".
   *
   * The real case: a $1 flat snake with three bites already recorded, switched
   * to 25c WITH doubling. The ladder becomes 25c → 50c → $1, so the holder owes
   * exactly the $1 they already owed — the settlement is unchanged (Snake pays
   * only at the end) and so is the position. Nothing to report by either
   * measure, and yet doubling is now on and the next bite goes to $2.
   */
  it('states the position even when the change happens to leave it alone', async () => {
    const roundId = await seed(snakeGames(), [
      ...[1, 2, 3, 4, 5].flatMap((hole) =>
        ['p-ann', 'p-bo', 'p-cal', 'p-dee'].map((playerId) => ({
          type: 'score/set' as const,
          playerId,
          hole,
          gross: 4,
        })),
      ),
      ...[
        [2, 'p-ann'],
        [3, 'p-bo'],
        [5, 'p-cal'],
      ].map(([hole, playerId]) => ({
        type: 'game/event' as const,
        gameId: 'game-1',
        kind: 'snake/bite',
        data: { hole, playerId },
      })),
    ])
    renderStart(roundId)
    await openEditor()

    // $1 → 25c, and doubling on: 25c, 50c, $1 — the holder owes the same $1
    fireEvent.click(screen.getByRole('button', { name: /decrease Pot/i }))
    fireEvent.click(screen.getByRole('button', { name: /decrease Pot/i }))
    fireEvent.click(screen.getByRole('button', { name: /decrease Pot/i }))
    fireEvent.click(screen.getByRole('switch', { name: /Doubling pot/i }))

    expect(await screen.findByText(/Riding: Cal · -\$1 x 3/)).toBeInTheDocument()
    // …said out loud, rather than the panel going quiet and reading as inert
    expect(screen.getByText(/unchanged/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing settled yet/)).toBeNull()
  })

  /**
   * A LOCKED FIELD IS SHOWN, NOT HIDDEN — and it is the round's state that locks
   * it, not the field. Before the first score Wolf's order is fully editable,
   * which is when a mis-entered one is actually noticed.
   */
  it('leaves a locked field editable before the first score', async () => {
    const roundId = await seed([
      {
        gameId: 'game-1',
        type: 'wolf',
        handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
        config: { pointCents: 100, rotation: ['p-ann', 'p-bo', 'p-cal', 'p-dee'] },
      },
    ])
    renderStart(roundId)
    await openEditor()

    expect(screen.getByRole('button', { name: /move Bo up/i })).toBeEnabled()
    expect(screen.queryByText(/Set at the first tee/)).toBeNull()
  })

  /**
   * …and refuses it afterwards, saying why. The control stays on screen because
   * the wolf order is exactly what a group goes looking for when they think it
   * is wrong — a field that silently vanished would read as one this game
   * doesn't have.
   */
  it('locks the wolf order once a score is in, and says why', async () => {
    const roundId = await seed(
      [
        {
          gameId: 'game-1',
          type: 'wolf',
          handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
          config: { pointCents: 100, rotation: ['p-ann', 'p-bo', 'p-cal', 'p-dee'] },
        },
      ],
      [{ type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 }],
    )
    renderStart(roundId)
    await openEditor()

    expect(screen.getByRole('button', { name: /move Bo up/i })).toBeDisabled()
    expect(screen.getByText(/Set at the first tee/)).toBeInTheDocument()
    // …while the stake on the same game is untouched by the lock
    expect(screen.getByRole('button', { name: /increase Per hole/i })).toBeEnabled()
  })

  /**
   * …and it unlocks again when the score that locked it is undone.
   *
   * The screen has to ask the question the FOLD asks, which is over EFFECTIVE
   * events: a retracted score never happened, so `amendRound` would take the
   * amendment while a raw read of the log still showed the field locked, under
   * a reason ("the round has been scored against it") that had stopped being
   * true.
   */
  it('unlocks the wolf order again when the only score is undone', async () => {
    const roundId = await seed(
      [
        {
          gameId: 'game-1',
          type: 'wolf',
          handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
          config: { pointCents: 100, rotation: ['p-ann', 'p-bo', 'p-cal', 'p-dee'] },
        },
      ],
      [{ type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 }],
    )
    const [score] = await eventStore.list(roundId)
    await eventStore.append(roundId, [{ type: 'meta/retract', targetEventId: score!.id }])

    renderStart(roundId)
    await openEditor()
    expect(screen.getByRole('button', { name: /move Bo up/i })).toBeEnabled()
    expect(screen.queryByText(/Set at the first tee/)).toBeNull()
  })

  /**
   * A SETTLED ROUND STATES ITS SETTINGS AND DOES NOT CHANGE THEM, for a sharper
   * reason than symmetry: nothing re-pushes a round because its log grew, so an
   * amendment made after Finish moves money on this phone and never reaches
   * `round_archives`. Reopen is the flow that pushes.
   */
  it('is read-only once the round is finished', async () => {
    const roundId = await seed(snakeGames(), [
      { type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 },
      { type: 'round/completed' },
    ])
    renderStart(roundId)
    fireEvent.click(await screen.findByRole('button', { name: /settings$/i }))

    expect(await screen.findByText(/Reopen it to change a bet/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByRole('button', { name: /increase Pot/i })).toBeDisabled()
  })

  /**
   * "We forgot to add the snake", on the 8th (MAI-103). It joins through the
   * SAME editor a game gets at setup, so it arrives configured rather than at
   * whatever the defaults happened to be.
   */
  it('adds a game mid-round, through the same editor', async () => {
    const roundId = await seed(
      [
        {
          gameId: 'game-1',
          type: 'skins',
          handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
          config: { stakeCents: 100, carryover: true },
        },
      ],
      [{ type: 'score/set', playerId: 'p-ann', hole: 1, gross: 4 }],
    )
    renderStart(roundId)

    fireEvent.click(await screen.findByRole('button', { name: '+ Add a side bet' }))
    fireEvent.click(await screen.findByRole('button', { name: /Snake/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))

    await waitFor(async () => {
      const events = await eventStore.list(roundId)
      expect(events.filter((e) => e.type === 'game/added')).toHaveLength(1)
    })
    // …and the round now derives it, on the holes already behind them
    expect(await screen.findByText(/Snake/)).toBeInTheDocument()
  })

  /**
   * REMOVING CONFIRMS, and what it promises is that the bet can come back. Its
   * own events are never deleted, so Restore brings them with it — which is
   * the whole reason a confirm is enough and an undo-only escape is not (the
   * header Undo reaches the log's tail and nothing further).
   */
  it('removes a game behind a confirm, and puts it back with its events', async () => {
    const roundId = await seed(
      [
        {
          gameId: 'game-1',
          type: 'skins',
          handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
          config: { stakeCents: 100, carryover: true },
        },
        {
          gameId: 'game-2',
          type: 'snake',
          handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
          config: { potCents: 100, doubling: false },
        },
      ],
      [
        ...['p-ann', 'p-bo', 'p-cal', 'p-dee'].map((playerId) => ({
          type: 'score/set' as const,
          playerId,
          hole: 1,
          gross: 4,
        })),
        { type: 'game/event', gameId: 'game-2', kind: 'snake/bite', data: { hole: 1, playerId: 'p-ann' } },
      ],
    )
    renderStart(roundId)

    // the snake's own settings sheet
    fireEvent.click((await screen.findAllByRole('button', { name: /settings$/i }))[1]!)
    fireEvent.click(await screen.findByRole('button', { name: /Remove from this round/i }))
    // it says what it costs and what survives, rather than just doing it
    expect(await screen.findByText(/its own record stays with the round/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    // gone from the round…
    expect(await screen.findByText(/Removed from this round/i)).toBeInTheDocument()

    // …and back, bite intact
    fireEvent.click(screen.getByRole('button', { name: /Restore/i }))
    await waitFor(() => expect(screen.queryByText(/Removed from this round/i)).toBeNull())
    const events = await eventStore.list(roundId)
    expect(events.filter((e) => e.type === 'game/event')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'game/added')).toHaveLength(1)
  })

  /**
   * `validateSetup` decides what is legal here exactly as it does in setup —
   * reused rather than re-stated, so a rule can never hold at tee-off and lapse
   * mid-round.
   */
  it('refuses a save the engine would reject', async () => {
    const roundId = await seed([
      {
        gameId: 'game-1',
        type: 'skins',
        handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
        config: { stakeCents: 100, carryover: true },
      },
      {
        gameId: 'game-2',
        type: 'skins',
        handicap: { mode: 'gross', allowancePct: 100, reference: 'absolute' },
        config: { stakeCents: 125, carryover: true },
      },
    ])
    renderStart(roundId)
    // edit the first Skins to match the second exactly
    fireEvent.click((await screen.findAllByRole('button', { name: /settings$/i }))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: /increase Skin value/i }))

    expect(
      await screen.findByText(/identical settings/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
