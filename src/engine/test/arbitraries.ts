import fc from 'fast-check'
import { EventLog, makeCourse, makePlayers, makeRound } from './harness'
import { holesForRound } from '../core/holes'
import type { HandicapSettings, Uuid } from '../core/types'

/**
 * The property suite's game registry (MAI-51).
 *
 * `replay.test.ts` guards zero-sum settlements, replay determinism, retraction
 * equivalence and correction equivalence — the invariants CLAUDE.md calls
 * non-negotiable. It used to build its rounds from one hand-written `fc.record`
 * whose fields were per-game (`carryover`, `autoPress`, `pickSeeds`) with games
 * pushed by player-count branches. Fine at five games; at twenty-five it is a
 * shared record nobody wants to touch, and the failure mode is the worst one
 * available: a new game silently stops being covered while CLAUDE.md tells its
 * author a property test has it.
 *
 * So each engine contributes its own arbitrary here instead. Adding a game
 * means adding one entry to `GAME_FUZZ` — and if you forget, the coverage test
 * in `replay.test.ts` fails by name.
 *
 * This is a REGISTRY IN THE TEST LAYER rather than a `testArbitrary` field on
 * `GameEngine`: the production interface every engine implements should not
 * grow a test concern.
 */

export interface FuzzEvent {
  kind: string
  data: Record<string, unknown>
}

/** A game's config for a round, plus the events it emits as holes are scored. */
export interface FuzzGame {
  config: unknown
  /**
   * Per-hole game events, called in log order AFTER that hole's scores are
   * appended — the same interleaving a scorekeeper produces.
   */
  events?: (hole: number, idx: number) => FuzzEvent[]
}

export interface GameFuzz {
  /** must match the registered engine's `type` */
  type: string
  /** can this engine legally join a round of this size? */
  eligible(playerCount: number): boolean
  /**
   * Seeds for this game, resolved into a config once the round's players exist.
   *
   * The two-step shape — an arbitrary of a FUNCTION of ids, rather than an
   * arbitrary taking ids — is what lets the generator keep every random field
   * in ONE flat `fc.record`. Deciding the player count first and generating
   * configs inside a `.chain()` would put the whole round behind a combinator
   * fast-check documents as shrinking poorly, and a suite whose entire value is
   * the MINIMAL counterexample cannot afford that: a real zero-sum bug would
   * report a full 18×4 score matrix instead of the two holes that cause it.
   */
  arbitrary(): fc.Arbitrary<(ids: readonly Uuid[]) => FuzzGame>
}

const skinsFuzz: GameFuzz = {
  type: 'skins',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    fc.boolean().map((carryover) => () => ({ config: { stakeCents: 100, carryover } })),
}

const nassauFuzz: GameFuzz = {
  type: 'nassau',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    fc.boolean().map((autoPress) => (ids) => ({
      config: {
        stakeCents: 500,
        // 2 → singles, 3 → 2v1 (uneven split), 4 → 2v2. The 2v1 is the point:
        // it exercises the lone-plays-each-opponent settlement, so zero-sum has
        // to hold when the two sides are different sizes.
        teams:
          ids.length === 4
            ? { a: [ids[0]!, ids[1]!], b: [ids[2]!, ids[3]!] }
            : ids.length === 3
              ? { a: [ids[0]!, ids[1]!], b: [ids[2]!] }
              : null,
        autoPress,
      },
    })),
}

const matchPlayFuzz: GameFuzz = {
  type: 'matchPlay',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    // 2 → singles. At 4 the boolean picks between an even 2v2 and a 3v1, and
    // the 3v1 is the point: nassau's fuzz never deals it, and it drives
    // `sideStake`'s lone branch at a ×3 multiplier rather than ×2, which is
    // where an uneven settlement would stop summing to zero if it were going
    // to. At 3 there is no even split to pick — both branches are a lone side,
    // and the boolean only chooses WHICH side is the lone one. That is worth
    // dealing anyway: side A and side B take different paths through the
    // settlement, so a multiplier applied to the wrong one shows up here.
    fc.boolean().map((lopsided) => (ids: readonly Uuid[]) => ({
      config: {
        stakeCents: 500,
        teams:
          ids.length === 4
            ? lopsided
              ? { a: [ids[0]!, ids[1]!, ids[2]!], b: [ids[3]!] }
              : { a: [ids[0]!, ids[1]!], b: [ids[2]!, ids[3]!] }
            : ids.length === 3
              ? lopsided
                ? { a: [ids[0]!], b: [ids[1]!, ids[2]!] }
                : { a: [ids[0]!, ids[1]!], b: [ids[2]!] }
              : null,
      },
    })),
}

const sixPointFuzz: GameFuzz = {
  type: 'sixPoint',
  // threesome-only, but it joins the fuzz like every other money game
  eligible: (n) => n === 3,
  arbitrary: () => fc.constant(() => ({ config: { pointCents: 25 } })),
}

const vegasFuzz: GameFuzz = {
  type: 'vegas',
  eligible: (n) => n === 4,
  arbitrary: () =>
    fc.constant((ids: readonly Uuid[]) => ({
      config: {
        pointCents: 10,
        teams: { a: [ids[0]!, ids[2]!], b: [ids[1]!, ids[3]!] },
        birdieFlip: true,
        eagleDouble: true,
      },
    })),
}

const wolfFuzz: GameFuzz = {
  type: 'wolf',
  eligible: (n) => n === 4,
  arbitrary: () =>
    // one pick seed per hole: 0-2 partner index, 3 lone, 4 blind, 5 no pick yet
    fc
      .array(fc.integer({ min: 0, max: 5 }), { minLength: 18, maxLength: 18 })
      .map((seeds) => (ids: readonly Uuid[]) => ({
        config: { pointCents: 100, rotation: [...ids] },
        events: (hole: number, idx: number) => {
          const seed = seeds[idx]!
          if (seed >= 5) return []
          // the wolf the rotation assigns, mirroring the engine. On the last
          // holes the engine switches to fewest-points, so a seeded pick can go
          // stale there — which is itself worth fuzzing, since a stale pick must
          // fall back to pending rather than compute a degenerate side.
          const wolfId = ids[idx % 4]!
          const others = ids.filter((id) => id !== wolfId)
          const choice = seed < 3 ? others[seed]! : seed === 3 ? 'lone' : 'blind'
          return [{ kind: 'wolf/pick', data: { hole, choice } }]
        },
      })),
}

/**
 * The award channel's property coverage (MAI-46), and the only one there is:
 * `ctp/award` is the first game event that carries a PLAYER rather than a
 * choice, and the first that a scorekeeper is expected to enter long after the
 * hole it names. Zero-sum, replay determinism and retraction equivalence all
 * have to survive that.
 *
 * One seed per hole: 0–3 award it to that player, 4 leave it unawarded, 5 award
 * it to a player who ISN'T in the round. The last is the important one — an
 * award naming a ghost must move no money rather than paying nobody a stake the
 * others still lose (which would be zero-sum's first real counterexample).
 * The seeded hole is deliberately NOT filtered to par 3s: an award on a par 4
 * is inert, and the fuzz should keep proving it.
 */
const ctpFuzz: GameFuzz = {
  type: 'ctp',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    fc
      .array(fc.integer({ min: 0, max: 5 }), { minLength: 18, maxLength: 18 })
      .map((seeds) => (ids: readonly Uuid[]) => ({
        config: { stakeCents: 200 },
        events: (hole: number, idx: number) => {
          const seed = seeds[idx]!
          if (seed === 4) return []
          const playerId = seed === 5 ? 'p-nobody' : (ids[seed % ids.length] ?? ids[0]!)
          return [{ kind: 'ctp/award', data: { hole, playerId } }]
        },
      })),
}

/**
 * The award channel's second game — and the first config in the catalog that
 * names HOLE NUMBERS.
 *
 * WHICH IS WHY IT DRAWS ONLY `par5s` AND `all`, NEVER A NOMINATED LIST. Do not
 * "complete" this by adding one: `arbitraryRotationPair` builds its straight
 * card by RENUMBERING the wrapped one and hands the SAME config to both. Every
 * other config in the catalog survives that — teams and rotations name players,
 * CTP's eligibility is read off par, and the renumbered card carries the same
 * pars in the same order. A list of hole numbers does not: at `startHole: 5`,
 * `holes: [3, 8]` sits at walk positions 16 and 3 on one card and 2 and 7 on
 * the other, while awards are seeded by POSITION — so the two settle
 * differently and the property fails on a perfectly correct engine.
 *
 * The nominated list is covered by goldens instead (`longDrive.test.ts` L7/L8),
 * which is where it belongs: nothing about it is order-blind.
 */
const longDriveFuzz: GameFuzz = {
  type: 'longDrive',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    fc
      .tuple(fc.boolean(), fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 18, maxLength: 18 }))
      .map(([everyHole, seeds]) => (ids: readonly Uuid[]) => ({
        config: { stakeCents: 200, holes: everyHole ? 'all' : 'par5s' },
        // one seed per hole: 0–3 award it to that player, 4 leave it
        // unawarded, 5 award it to somebody who ISN'T in the round — which
        // must move no money rather than pay a ghost. Not filtered to
        // designated holes: an award on an ineligible one is inert, and the
        // fuzz should keep proving it.
        events: (hole: number, idx: number) => {
          const seed = seeds[idx]!
          if (seed === 4) return []
          const playerId = seed === 5 ? 'p-nobody' : (ids[seed % ids.length] ?? ids[0]!)
          return [{ kind: 'longDrive/award', data: { hole, playerId } }]
        },
      })),
}

/**
 * THE FIRST ENTRY WITH NO EVENTS OF ITS OWN (MAI-58), which is the whole reason
 * it belongs here. Snake's entire state comes from facts the ROUND deals —
 * `puttSeeds` above and the `completed` flag — so zero-sum, replay determinism,
 * retraction equivalence and the rotation pair all get exercised over a game
 * that reads `RoundContext` and nothing else. It is also the only game in the
 * fuzz whose money exists solely on a completed round, so it is what makes that
 * dimension load-bearing rather than merely covered.
 */
const snakeFuzz: GameFuzz = {
  type: 'snake',
  eligible: (n) => n >= 2,
  arbitrary: () =>
    fc.boolean().map((doubling) => () => ({ config: { potCents: 100, doubling } })),
}

/**
 * Order matters: it decides the order games sit in `round.games`, and so which
 * `gameId` each one gets. Keep new entries appended.
 */
export const GAME_FUZZ: readonly GameFuzz[] = [
  skinsFuzz,
  nassauFuzz,
  sixPointFuzz,
  vegasFuzz,
  wolfFuzz,
  ctpFuzz,
  matchPlayFuzz,
  longDriveFuzz,
  snakeFuzz,
]

const PLAYER_NAMES = ['A', 'B', 'C', 'D'] as const

/**
 * PUTTS ARE DEALT BY THE ROUND, NOT BY A GAME (MAI-90).
 *
 * `FuzzGame.events` emits `game/event` only, which is right — putts are a
 * scorecard fact that several games read and none owns, so they belong beside
 * the scores in the generators below rather than inside whichever engine
 * happens to want them.
 *
 * One seed per player per hole: 0–4 is a COUNT (0 is a chip-in, and is not the
 * same as unrecorded — the distinction `ctx.puttsFor` exists to keep); 5
 * records three and then CLEARS them, which must leave the hole not-recorded
 * rather than at zero, and gives retraction-equivalence a second event kind to
 * chew on; 6 leaves the hole alone.
 */
function appendPutts(log: EventLog, seed: number, playerId: Uuid, hole: number): void {
  if (seed <= 4) {
    log.append({ type: 'score/putts', playerId, hole, putts: seed })
  } else if (seed === 5) {
    log.append({ type: 'score/putts', playerId, hole, putts: 3 })
    log.append({ type: 'score/puttsClear', playerId, hole })
  }
}

/** Per hole, per player-slot, drawn for all 18 so the walk always has cover. */
const puttSeeds = () =>
  fc.array(fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 4, maxLength: 4 }), {
    minLength: 18,
    maxLength: 18,
  })

/**
 * A round of 2–4 players with every eligible game, and a log of hole-by-hole
 * scores interleaved with each game's own events.
 *
 * Every random field lives in ONE flat `fc.record` — including the player
 * count — so fast-check can shrink them jointly. Seeds are therefore DRAWN for
 * every registered game and the ineligible ones simply go unused: a few wasted
 * draws, in exchange for minimal counterexamples. See `GameFuzz.arbitrary`.
 *
 * `extra` appends fuzz entries for engines registered by the calling test —
 * used by `replay.guard.test.ts` to prove the suite actually fails on a broken
 * engine. Passing them in beats mutating `GAME_FUZZ`, which would leak between
 * tests in the same file.
 */
export function arbitraryRoundAndEvents(extra: readonly GameFuzz[] = []) {
  const registry = [...GAME_FUZZ, ...extra]
  return fc
    .record({
      playerCount: fc.integer({ min: 2, max: 4 }),
      handicaps: fc.array(fc.integer({ min: -3, max: 24 }), { minLength: 4, maxLength: 4 }),
      net: fc.boolean(),
      /**
       * Where the round tees off, wrapping from there (MAI-41).
       *
       * This carries the ORDER-BLIND properties — zero-sum, replay
       * determinism, retraction equivalence — onto rounds where hole 3 is
       * played fifteenth. Worth having, but be clear about what it cannot see:
       * every one of those properties holds just as well when an engine
       * confuses hole number with position. Match Play settled nine holes
       * early and balanced to the cent (`matchPlay.test.ts` MP12).
       *
       * The property that CAN see it is `arbitraryRotationPair` below.
       *
       * In the flat record with everything else, so fast-check shrinks it
       * jointly and a real failure reports the SIMPLEST start hole that shows
       * it — 1 wherever the rotation isn't the cause.
       */
      startHole: fc.integer({ min: 1, max: 18 }),
      // per hole per player: gross score or null (unscored)
      scores: fc.array(
        fc.array(fc.option(fc.integer({ min: 1, max: 12 }), { nil: null }), {
          minLength: 4,
          maxLength: 4,
        }),
        { minLength: 1, maxLength: 18 },
      ),
      putts: puttSeeds(),
      /**
       * DOES THE ROUND FINISH? Until this existed, no property run ever
       * completed one — so every `ctx.completed` branch in the catalog went
       * unfuzzed: Skins' dead carry, CTP's and Long Drive's unclaimed holes,
       * Wolf's missing picks, and any game that settles only at the end.
       *
       * A boolean rather than always-on, so both worlds stay covered and
       * fast-check shrinks to `false` — a counterexample that survives to there
       * is not about completion.
       */
      completed: fc.boolean(),
      games: fc.tuple(...registry.map((g) => g.arbitrary())),
    })
    .map(({ playerCount, handicaps, net, startHole, scores, putts, completed, games }) => {
      const players = makePlayers(
        PLAYER_NAMES.slice(0, playerCount).map((name, i) => ({ name, ch: handicaps[i]! })),
      )
      // READ the ids off the players rather than re-deriving the harness's id
      // scheme. A private copy that drifts would point every `teams` and
      // `rotation` at players who aren't in the round — and the games would
      // still derive, settling $0 for everyone. Zero-sum, determinism and
      // retraction-equivalence would all pass over rounds that test nothing.
      const ids = players.map((p) => p.playerId)
      const handicap: HandicapSettings = net
        ? { mode: 'net', allowancePct: 100, reference: 'offLow' }
        : { mode: 'gross', allowancePct: 100, reference: 'absolute' }

      // Eligibility is decided BEFORE the builder runs, not after. A builder
      // handed a roster its game can't seat indexes past the end — Vegas at two
      // players would compose `teams` out of two ids and two `undefined`s, hidden
      // behind a non-null assertion. Harmless while the result is dropped on the
      // next line, and a live bug the moment anyone validates or logs the games
      // this generator produces.
      const entries = registry
        .map((g, i) => ({ g, build: games[i]! }))
        .filter(({ g }) => g.eligible(playerCount))
        .map(({ g, build }) => ({ type: g.type, game: build(ids) }))

      const round = makeRound({
        players,
        holes: 'full18',
        startHole,
        // No engine reads this — only the scoring screen does — but a round
        // carrying putts while denying it counts them is a lie waiting to
        // confuse whoever reads a counterexample.
        trackPutts: true,
        games: entries.map((e) => ({ type: e.type, config: e.game.config, handicap })),
      })

      const log = new EventLog()
      // Score the holes IN PLAY ORDER, which on a wrapped round is not 1,2,3…
      // `holeIdx` stays the position in the walk, so each game's per-hole seeds
      // (Wolf's rotation, CTP's awards) line up with the hole the engine will
      // put them on — the same index the engine rotates by.
      const holesPlayed = holesForRound(round)
      scores.forEach((byPlayer, holeIdx) => {
        const hole = holesPlayed[holeIdx]!
        players.forEach((p, pi) => {
          const gross = byPlayer[pi]
          if (gross !== null && gross !== undefined) {
            log.append({ type: 'score/set', playerId: p.playerId, hole, gross })
          }
        })
        // putts sit beside the stroke on the row, so they land with it
        players.forEach((p, pi) => appendPutts(log, putts[holeIdx]![pi]!, p.playerId, hole))
        // each game's own events land after that hole's scores, in log order
        entries.forEach((e, gi) => {
          if (!e.game.events) return
          const gameId = round.games[gi]!.gameId
          for (const ev of e.game.events(hole, holeIdx)) {
            log.append({ type: 'game/event', gameId, kind: ev.kind, data: ev.data })
          }
        })
      })
      if (completed) log.append({ type: 'round/completed' })
      return { round, log }
    })
}

/** The default harness card, spelled out so a rotation can be built from it. */
const PARS = [4, 4, 5, 3, 4, 4, 3, 5, 4, 4, 5, 3, 4, 4, 5, 3, 4, 4]
const SIS = [5, 13, 1, 9, 17, 3, 11, 7, 15, 6, 2, 16, 10, 4, 8, 18, 12, 14]

/**
 * THE ENFORCEMENT of "compare position in `ctx.holesPlayed`, never hole number"
 * (CLAUDE.md invariant 9) — the one property that can actually fail on it.
 *
 * Every other property in `replay.test.ts` is order-BLIND: zero-sum, replay
 * determinism, retraction equivalence and "every line moves money" would all
 * pass over engines that had confused a hole's number with its place in the
 * round. Dealing a random `startHole` to them proves engines don't crash or
 * unbalance on a wrapped round. It cannot prove they compute the right thing.
 *
 * So deal the SAME GOLF twice:
 *
 *   WRAPPED  — the ordinary card, teeing off on hole S, walking [S…18, 1…S-1].
 *   STRAIGHT — a card RENUMBERED so that walking it 1…18 presents the very same
 *              sequence of pars and stroke indexes, teeing off on 1.
 *
 * Position for position these are the same round of golf: the same player wins
 * the same nth hole against the same par off the same stroke index. Only the
 * NUMBERS painted on the tee markers differ. So every engine must settle them
 * identically, and land each payment on the same hole of the walk.
 *
 * WHAT IT CATCHES, verified by reintroducing each bug and watching it fail:
 * splitting nassau's nines by card number (`filter(h <= 9)`) — caught, the
 * money comes apart; and the ledger's numeric prefix (`eventHole(e) <= hole`)
 * — caught, the money lands on the wrong rows while the total stays right.
 *
 * WHAT IT DOES NOT CATCH, equally verified: the match kit's old
 * `filter(h >= startHole)`. That one is real and user-facing but costs no
 * money — `holesRemaining` reaches only the to-play count, the dormie test and
 * the close NOTE, while every settlement is gated on `closedAt`, which comes
 * from the always-positional `toPlayAfterIn`. Goldens hold that line
 * (`matchPlay.test.ts` MP12), and a property comparing money never will.
 *
 * Money and its placement, deliberately — not prose. Hole numbers legitimately
 * appear in narration (`Press @12`, "hole 7 halved"), so asserting on strings
 * would fail for a perfectly correct engine.
 */
export function arbitraryRotationPair(extra: readonly GameFuzz[] = []) {
  const registry = [...GAME_FUZZ, ...extra]
  return fc
    .record({
      playerCount: fc.integer({ min: 2, max: 4 }),
      handicaps: fc.array(fc.integer({ min: -3, max: 24 }), { minLength: 4, maxLength: 4 }),
      net: fc.boolean(),
      // 1 is included and is where fast-check shrinks to: at startHole 1 the
      // two rounds are literally identical, so a counterexample that survives
      // shrinking to 1 is a bug in something other than rotation.
      startHole: fc.integer({ min: 1, max: 18 }),
      scores: fc.array(
        fc.array(fc.option(fc.integer({ min: 1, max: 12 }), { nil: null }), {
          minLength: 4,
          maxLength: 4,
        }),
        { minLength: 1, maxLength: 18 },
      ),
      putts: puttSeeds(),
      completed: fc.boolean(),
      games: fc.tuple(...registry.map((g) => g.arbitrary())),
    })
    .map(({ playerCount, handicaps, net, startHole, scores, putts, completed, games }) => {
      const players = makePlayers(
        PLAYER_NAMES.slice(0, playerCount).map((name, i) => ({ name, ch: handicaps[i]! })),
      )
      const ids = players.map((p) => p.playerId)
      const handicap: HandicapSettings = net
        ? { mode: 'net', allowancePct: 100, reference: 'offLow' }
        : { mode: 'gross', allowancePct: 100, reference: 'absolute' }
      const entries = registry
        .map((g, i) => ({ g, build: games[i]! }))
        .filter(({ g }) => g.eligible(playerCount))
        .map(({ g, build }) => ({ type: g.type, game: build(ids) }))
      const gameDefs = entries.map((e) => ({ type: e.type, config: e.game.config, handicap }))

      const wrapped = makeRound({
        players,
        holes: 'full18',
        startHole,
        trackPutts: true,
        games: gameDefs,
      })
      const walk = holesForRound(wrapped)
      // The renumbered card: its hole i+1 IS the (i+1)th hole of the wrapped
      // walk, carrying that hole's par and stroke index so handicap allocation
      // and every par-sensitive game (CTP's par 3s) see the same round.
      const straight = makeRound({
        players,
        holes: 'full18',
        trackPutts: true,
        course: makeCourse(
          walk.map((h) => PARS[h - 1]!),
          walk.map((h) => SIS[h - 1]!),
        ),
        games: gameDefs,
      })

      const logFor = (holeAt: (idx: number) => number) => {
        const log = new EventLog()
        scores.forEach((byPlayer, holeIdx) => {
          const hole = holeAt(holeIdx)
          players.forEach((p, pi) => {
            const gross = byPlayer[pi]
            if (gross !== null && gross !== undefined) {
              log.append({ type: 'score/set', playerId: p.playerId, hole, gross })
            }
          })
          // the same putts at the same POSITION of the walk, so both cards see
          // the identical three-putt on the identical hole OF THE ROUND
          players.forEach((p, pi) => appendPutts(log, putts[holeIdx]![pi]!, p.playerId, hole))
          entries.forEach((e, gi) => {
            if (!e.game.events) return
            const gameId = wrapped.games[gi]!.gameId
            // the SAME seed at the same position, addressed to whichever hole
            // number that position carries on this card
            for (const ev of e.game.events(hole, holeIdx)) {
              log.append({ type: 'game/event', gameId, kind: ev.kind, data: ev.data })
            }
          })
        })
        if (completed) log.append({ type: 'round/completed' })
        return log
      }

      return {
        startHole,
        wrapped: { round: wrapped, log: logFor((i) => walk[i]!) },
        straight: { round: straight, log: logFor((i) => i + 1) },
      }
    })
}
