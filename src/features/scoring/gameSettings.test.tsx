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
    expect(await screen.findByText(/Now riding: Ann · -\$1\.25 x 3/)).toBeInTheDocument()
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
