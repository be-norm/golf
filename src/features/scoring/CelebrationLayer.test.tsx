import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import '../../engine/games'
import { deriveRound } from '../../engine/catalog'
import { EventLog, makePlayers, makeRound } from '../../engine/test/harness'
import type { RoundEvent } from '../../engine/core/events'
import type { Round } from '../../engine/core/types'
import { CelebrationLayer } from './CelebrationLayer'
import type { RoundView } from './useRound'

/**
 * THE FIRING RULES (MAI-36).
 *
 * `deriveRound` recomputes wholesale and nothing it returns is flavoured with
 * newness — `celebration(3)` answers identically on the tap that decided hole 3
 * and on every render for the rest of the round. So every test here is about
 * WHEN the layer fires, never about what the engine said, and each one pins a
 * rule that was a bug first.
 *
 * The layer measures DOM rects to place the coins; jsdom reports zeroes for all
 * of them, which is fine — placement is untested by design (as the share card's
 * painter is), and "did a sprite mount" is the whole question here.
 */

const P = ['A', 'B', 'C', 'D']

function skinsRound(): Round {
  const players = makePlayers(P.map((name) => ({ name })))
  return makeRound({
    players,
    holes: 'front9',
    games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
  })
}

function viewOf(round: Round, events: RoundEvent[]): RoundView {
  return { round, events: [...events], ...deriveRound(round, events) }
}

/** A wins hole 1 outright; everyone else ties it. */
function winHole(log: EventLog, round: Round, hole: number, winner = 'A') {
  const idOf = new Map(round.players.map((p) => [p.name, p.playerId]))
  for (const name of P) {
    log.append({
      type: 'score/set',
      playerId: idOf.get(name)!,
      hole,
      gross: name === winner ? 3 : 5,
    })
  }
}

/** Everyone halves the hole — no skin, the pile carries. */
function tieHole(log: EventLog, round: Round, hole: number) {
  const idOf = new Map(round.players.map((p) => [p.name, p.playerId]))
  for (const name of P) {
    log.append({ type: 'score/set', playerId: idOf.get(name)!, hole, gross: 4 })
  }
}

const coins = (c: HTMLElement) => c.querySelectorAll('[data-sprite="coin"]').length

describe('CelebrationLayer', () => {
  /**
   * RULE 1 — resuming a round is not a win. Every decided hole is still fully
   * reported by the derivation when you reopen the round on the 14th tee; a
   * layer that treated "reported" as "new" would replay the whole front nine at
   * once, which is the failure the seed exists to prevent.
   */
  it('says nothing when opening a round that already has decided holes', () => {
    const round = skinsRound()
    const log = new EventLog()
    winHole(log, round, 1)
    winHole(log, round, 2, 'B')
    const { container } = render(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(0)
  })

  /**
   * RULE 1, THE OTHER HALF — seeding must key off the first render that HAS a
   * view, not off mount. `useRound` returns `undefined` while Dexie loads, so a
   * mount-keyed seed records nothing and then treats the entire first real
   * derivation as new. Same bug as above, reached by a different road, and it
   * is the one that only shows up on a cold open.
   */
  it('says nothing when the round arrives a render after mounting', () => {
    const round = skinsRound()
    const log = new EventLog()
    winHole(log, round, 1)
    winHole(log, round, 2, 'B')
    const { container, rerender } = render(<CelebrationLayer view={undefined} />)
    rerender(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(0)
  })

  it('fires once when a hole is newly won, with one coin per skin banked', () => {
    const round = skinsRound()
    const log = new EventLog()
    tieHole(log, round, 1)
    const { container, rerender } = render(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(0)

    // hole 2 banks its own skin plus the one carried from hole 1
    winHole(log, round, 2)
    rerender(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(2)
  })

  /**
   * RULE 2 — an undo is not a win, EVEN WHEN IT CREATES ONE.
   *
   * Retracting the WINNER's score needs no guard: the hole falls back to
   * pending and there is no celebration left to suppress. (Skins decides a hole
   * only once everyone has posted, so removing any score un-decides it.)
   *
   * The case the guard is for is undoing a CORRECTION. Retraction is
   * compensation, not deletion — drop the correcting event and the player's
   * earlier score is last-write-wins again. So: A wins the hole, someone fixes
   * B's score to a tie, then undoes that fix, and A is winning it once more.
   * Money moves, a celebration appears, and the append that produced it was a
   * `meta/retract`.
   *
   * Celebrating there is wrong twice over — nobody just holed a putt, and the
   * thing being undone is the scorekeeper's own typo.
   */
  it('says nothing when an undo is what restores the win', () => {
    const round = skinsRound()
    const log = new EventLog()
    const idOf = new Map(round.players.map((p) => [p.name, p.playerId]))
    winHole(log, round, 1) // A 3, everyone else 5
    const { container, rerender } = render(<CelebrationLayer view={viewOf(round, log.events)} />)

    // "B was a 3 as well" — the hole ties and A's skin evaporates
    const fix = log.append({ type: 'score/set', playerId: idOf.get('B')!, hole: 1, gross: 3 })
    rerender(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(0)

    // …no it wasn't. Undo the fix: B reverts to 5 and A wins hole 1 again.
    log.append({ type: 'meta/retract', targetEventId: fix.id })
    const after = viewOf(round, log.events)
    // the celebration really is back — otherwise this passes by having nothing
    // to suppress, which is how the first version of it proved nothing at all
    expect(after.derivations.get('game-1')!.celebration!(1)).toMatchObject({
      playerIds: [idOf.get('A')],
    })
    rerender(<CelebrationLayer view={after} />)
    expect(coins(container)).toBe(0)
  })

  /**
   * Walking back to look at hole 3 re-renders the screen with an identical log.
   * Nothing new happened, so nothing should fire — the log length, not the
   * render, is what says whether there is news.
   */
  it('says nothing when only the rendered hole changes', () => {
    const round = skinsRound()
    const log = new EventLog()
    winHole(log, round, 1)
    const view = viewOf(round, log.events)
    const { container, rerender } = render(<CelebrationLayer view={view} />)
    // a fresh object each time, exactly as `useRound`'s useMemo produces
    rerender(<CelebrationLayer view={viewOf(round, log.events)} />)
    rerender(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(0)
  })

  /**
   * RULE 3 — ONE PER APPEND, and a round holding two games is what makes it
   * load-bearing. Both games decide hole 1 off the same scores, so the append
   * that finishes the hole produces a celebration in each; uncapped, they fire
   * on top of each other, from the same bar, to the same row.
   *
   * Two Skins games is a real setup, not a contrivance — a round can hold two
   * instances of one game (MAI-44), and a $1 skin beside a $20 skin is exactly
   * why. It is also the smallest case that produces two celebrations from one
   * append, which is what this rule is about.
   */
  it('fires once when two games both decide the same hole', () => {
    const players = makePlayers(P.map((name) => ({ name })))
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        { type: 'skins', config: { stakeCents: 100, carryover: true } },
        { type: 'skins', config: { stakeCents: 2000, carryover: true } },
      ],
    })
    const log = new EventLog()
    const idOf = new Map(round.players.map((p) => [p.name, p.playerId]))
    for (const name of ['A', 'B', 'C'] as const) {
      log.append({ type: 'score/set', playerId: idOf.get(name)!, hole: 1, gross: name === 'A' ? 3 : 5 })
    }
    const { container, rerender } = render(<CelebrationLayer view={viewOf(round, log.events)} />)

    log.append({ type: 'score/set', playerId: idOf.get('D')!, hole: 1, gross: 5 })
    const after = viewOf(round, log.events)
    // both games really do have something to say — otherwise the cap is being
    // "proved" by there being nothing to cap
    expect(after.derivations.get('game-1')!.celebration!(1)).not.toBeNull()
    expect(after.derivations.get('game-2')!.celebration!(1)).not.toBeNull()

    rerender(<CelebrationLayer view={after} />)
    expect(coins(container)).toBe(1)
  })

  /**
   * THE CASCADE, which turns out to be handled by the KEY rather than the cap —
   * worth a test precisely because the obvious reading is wrong.
   *
   * Skins' carry flows forward, so correcting hole 1 re-derives every later
   * hole. But what changes downstream is the COUNT, never which holes were won:
   * hole 3 goes from "A wins 3 skins" to "A wins 2", and since the key is
   * (game, hole, sprite) it is not a new celebration and does not re-fire. Only
   * hole 1 — newly won by B — is new.
   *
   * So a settled hole quietly updates its arithmetic without shouting about it,
   * and the one thing that DID just happen is the one thing that animates.
   */
  it('re-fires only the corrected hole, not the ones its carry re-priced', () => {
    const round = skinsRound()
    const log = new EventLog()
    const idOf = new Map(round.players.map((p) => [p.name, p.playerId]))
    tieHole(log, round, 1)
    tieHole(log, round, 2)
    winHole(log, round, 3) // A banks 3
    const { container, rerender } = render(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(0)

    // B actually made 3 on the first hole
    log.append({ type: 'score/set', playerId: idOf.get('B')!, hole: 1, gross: 3 })
    const after = viewOf(round, log.events)
    const d = after.derivations.get('game-1')!
    // the cascade is real: hole 3's pile shrank from 3 to 2
    expect(d.celebration!(3)).toMatchObject({ count: 2 })
    expect(d.celebration!(1)).toMatchObject({ count: 1, playerIds: [idOf.get('B')] })

    rerender(<CelebrationLayer view={after} />)
    expect(container.querySelectorAll('[data-sprite]').length).toBe(1)
    expect(container.textContent).toContain('B wins 1 skin')
  })

  /**
   * ROUND COMPLETION DECIDES HOLES, which is precisely when a naive layer
   * throws its biggest burst — and this is reachable today, not a hypothetical
   * for some future engine.
   *
   * Somebody picks up and never posts a score. That hole stays pending all
   * round; "Finish round early" then settles it among the scores that WERE
   * posted, so the completion append hands back a freshly-won hole. `eventHole`
   * answers null for `round/completed` because it belongs to no hole, and the
   * layer declines on that basis.
   *
   * The partial hole is the whole point of the fixture: a fully-scored card
   * decides nothing new at completion, so it passes with or without the guard.
   */
  it('says nothing when finishing the round is what decides a hole', () => {
    const round = skinsRound()
    const log = new EventLog()
    const idOf = new Map(round.players.map((p) => [p.name, p.playerId]))
    winHole(log, round, 1, 'A')
    // hole 2: C and D never post — nothing is decided while the round is live
    log.append({ type: 'score/set', playerId: idOf.get('A')!, hole: 2, gross: 5 })
    log.append({ type: 'score/set', playerId: idOf.get('B')!, hole: 2, gross: 3 })
    const live = viewOf(round, log.events)
    expect(live.derivations.get('game-1')!.celebration!(2)).toBeNull()

    const { container, rerender } = render(<CelebrationLayer view={live} />)
    log.append({ type: 'round/completed' })
    const finished = viewOf(round, log.events)
    // completion really did hand back a new celebration — otherwise this test
    // passes by having nothing to suppress
    expect(finished.derivations.get('game-1')!.celebration!(2)).toMatchObject({
      playerIds: [idOf.get('B')],
    })

    rerender(<CelebrationLayer view={finished} />)
    expect(coins(container)).toBe(0)
  })

  /**
   * A CORRECTION THAT HANDS THE HOLE TO SOMEONE ELSE IS NEWS. The money moves
   * from one player to another, so staying silent is the opposite of quiet.
   *
   * This is why the key carries the winner. It is also the line between the two
   * things the key has to tell apart: a carry re-pricing a settled hole (same
   * winner, different count — silent) and a hole changing hands (different
   * winner — announced).
   */
  it('fires again when a correction hands a won hole to a different player', () => {
    const round = skinsRound()
    const log = new EventLog()
    const idOf = new Map(round.players.map((p) => [p.name, p.playerId]))
    winHole(log, round, 1, 'A')
    const { container, rerender } = render(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(0)

    // B was actually a 2 — hole 1 is B's now, and A's skin is gone
    log.append({ type: 'score/set', playerId: idOf.get('B')!, hole: 1, gross: 2 })
    const after = viewOf(round, log.events)
    expect(after.derivations.get('game-1')!.celebration!(1)).toMatchObject({
      playerIds: [idOf.get('B')],
    })
    rerender(<CelebrationLayer view={after} />)
    expect(coins(container)).toBe(1)
    expect(container.textContent).toContain('B wins 1 skin')
  })

  /**
   * Undo, then re-enter the same score. It happened twice, so it celebrates
   * twice — which is what dropping keys the derivation stops reporting buys,
   * and is why the seen-set is replaced each pass rather than only added to.
   */
  it('celebrates again when an undone hole is won back', () => {
    const round = skinsRound()
    const log = new EventLog()
    const idOf = new Map(round.players.map((p) => [p.name, p.playerId]))
    tieHole(log, round, 1)
    winHole(log, round, 2)
    const { container, rerender } = render(<CelebrationLayer view={viewOf(round, log.events)} />)

    const aOnTwo = log.events.find(
      (e) => e.type === 'score/set' && e.hole === 2 && e.playerId === idOf.get('A'),
    )!
    log.append({ type: 'meta/retract', targetEventId: aOnTwo.id })
    rerender(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(0)

    log.append({ type: 'score/set', playerId: idOf.get('A')!, hole: 2, gross: 3 })
    rerender(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(coins(container)).toBe(2)
  })

  /**
   * THE OTHER SHAPE (MAI-94). Wolf declares `style: 'scene'`, and the layer has
   * to honour it without knowing what Wolf is: one sprite, centre screen, no
   * row measured and no bar to leave from.
   *
   * Worth its own test because the shared contract sweep in `catalog.test.ts`
   * derives every engine with no game events, so Wolf's every hole is pending
   * there and it contributes nothing — this is the only place the second engine
   * on this channel is shown actually reaching the screen.
   */
  it('plays a scene in place instead of throwing it at a row', () => {
    const players = makePlayers(P.map((name) => ({ name })))
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        {
          type: 'wolf',
          config: { pointCents: 100, rotation: players.map((p) => p.playerId) },
        },
      ],
    })
    const idOf = new Map(round.players.map((p) => [p.name, p.playerId]))
    const log = new EventLog()
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'wolf/pick',
      data: { hole: 1, choice: 'lone' },
    })
    const { container, rerender } = render(<CelebrationLayer view={viewOf(round, log.events)} />)
    expect(container.querySelectorAll('[data-sprite]').length).toBe(0)

    // A goes alone and beats all three
    for (const name of P) {
      log.append({ type: 'score/set', playerId: idOf.get(name)!, hole: 1, gross: name === 'A' ? 3 : 5 })
    }
    rerender(<CelebrationLayer view={viewOf(round, log.events)} />)

    // ONE of it, whatever the hole was worth — a scene does not multiply
    const sprite = container.querySelector<HTMLElement>('[data-sprite="wolf"]')
    expect(container.querySelectorAll('[data-sprite]').length).toBe(1)
    expect(container.textContent).toContain('A lone +6')

    // A COUNT OF SPRITES CANNOT TELL THE TWO SHAPES APART — a one-skin toss
    // mounts exactly one as well, so the assertions that matter are the ones
    // the shape actually changes. It plays ONCE and rests on its final frame
    // (for Wolf, the ball filling the box) where a toss loops for the whole
    // flight; and it is drawn at the scene scale, which is what makes a club
    // distinguishable from a ball at arm's length.
    expect(sprite!.style.animationIterationCount).toBe('1')
    expect(sprite!.parentElement!.style.width).toBe('160px')
  })
})
