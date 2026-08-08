import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound, getEngine } from '../../catalog'
import { EventLog, makePlayers, makeRound } from '../../test/harness'

function pick(log: EventLog, hole: number, choice: string) {
  log.append({ type: 'game/event', gameId: 'game-1', kind: 'wolf/pick', data: { hole, choice } })
}

describe('wolf — golden fixture (hand-verified)', () => {
  /**
   * Gross wolf, $1 a hole, front 9, rotation A,B,C,D (8 rotation holes + 1 trailing).
   * HAND-DERIVED from the rules, not read back off the engine. Units per
   * opponent: partnered 1, lone 2, blind 3; the outnumbered side settles
   * against EACH opponent, so a lone hole is ±6 for the wolf and ∓2 for the
   * other three.
   *
   *   h1  A+B (4) beat C,D (5)          → A+1 B+1 C−1 D−1
   *   h2  B lone (3) beats A,C,D (4)    → B+6 A−2 C−2 D−2
   *   h3  C+D (5) lose to A,B (4)       → C−1 D−1 A+1 B+1
   *   h4  D blind (5) loses to ABC (4)  → D−9 A+3 B+3 C+3
   *   h5  A lone, 4 v 4                 → halved, nobody moves
   *   h6  B+C (4) lose to A,D (3)       → B−1 C−1 A+1 D+1
   *   h7  C+A (3) beat B,D (4)          → C+1 A+1 B−1 D−1
   *   h8  D+A (4) beat B,C (5)          → D+1 A+1 B−1 C−1
   *
   *   after 8: A 6 · B 8 · C −2 · D −12   (sums to 0)
   *
   * h9 has no rotation left, so the wolf is the trailing player — D on −12.
   * (It was C under the old scoring; the totals themselves changed, so the
   * trailing-player rule picks someone else. That is the rule working, not a
   * fixture drifting.) D rides with B, 4 v 4 → halved.
   *
   * Money is the swing at face value: A +$6, B +$8, C −$2, D −$12.
   */
  it('rotation, lone/blind multipliers, trailing-player wolf, swing settlement', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        {
          type: 'wolf',
          config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] },
        },
      ],
    })
    const log = new EventLog()
    pick(log, 1, 'p-b') // A rides with B
    pick(log, 2, 'lone') // B lone
    pick(log, 3, 'p-d') // C rides with D
    pick(log, 4, 'blind') // D blind
    pick(log, 5, 'lone') // A lone
    pick(log, 6, 'p-c') // B rides with C
    pick(log, 7, 'p-a') // C rides with A
    pick(log, 8, 'p-a') // D rides with A
    log.scoreByHole(round, {
      A: [4, 4, 4, 4, 4, 3, 4, 4, 4],
      B: [5, 3, 6, 4, 4, 4, 4, 5, 4],
      C: [5, 4, 5, 4, 4, 4, 3, 5, 4],
      D: [5, 4, 5, 5, 4, 5, 4, 4, 4],
    })
    pick(log, 9, 'p-b') // trailing-player wolf (D, on −12) rides with B

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.perPlayerCents).toEqual({
      'p-a': 600,
      'p-b': 800,
      'p-c': -200,
      'p-d': -1200,
    })
    // every hole's swing nets out, so the round does too
    expect(Object.values(d.settlement.perPlayerCents).reduce((a, b) => a + b, 0)).toBe(0)
    // the trailing player takes the last wolf — D, not C, under these totals
    expect(d.holeSummary(9)[0]).toContain('Wolf D')
    expect(d.holeSummary(2)[0]).toContain('B +6')
    // blind loss: the other three collect three stakes each
    expect(d.holeSummary(4)[0]).toContain('+3')
    // bar recaps the latest decided hole (h9: D rides with B, 4 v 4 → halved)
    expect(d.summaryParts![0]!.label).toBe('H9')
  })

  it('blocks with a pick prompt when the hole is scored but no pick exists', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
      ],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4], B: [5], C: [5], D: [5] }, [1])

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    const inputs = d.requiredInputs()
    // hole 1 blocks (scored, no pick); hole 2 pre-prompts the next wolf off the tee
    expect(inputs.map((i) => i.hole)).toEqual([1, 2])
    expect(inputs[0]).toMatchObject({ hole: 1, eventKind: 'wolf/pick' })
    expect(inputs[0]!.prompt).toContain('A')
    // no points until the pick lands
    expect(Object.values(d.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)

    pick(log, 1, 'lone')
    const after = deriveRound(round, log.events).derivations.get('game-1')!
    expect(after.requiredInputs().map((i) => i.hole)).toEqual([2])
    // lone win: the wolf plays the doubled hole against each of three → 6 stakes
    expect(after.settlement.perPlayerCents['p-a']).toBe(600)
    expect(after.settlement.perPlayerCents['p-b']).toBe(-200)
    // bar recaps the solo win with its mode tag
    expect(after.summaryParts).toEqual([{ label: 'H1', value: 'A lone +6' }])
  })

  /**
   * THE guarantee that used to come for free.
   *
   * `pointsToMoney` was zero-sum by construction for any field; settling the
   * swing directly means zero-sum instead follows from each hole's units
   * balancing. `sideStake` is what makes that true (an outnumbered player
   * settles against each opponent), and this is where it is checked — every
   * outcome the game can produce, in one place, in dollars.
   */
  describe('every outcome balances', () => {
    const round = () =>
      makeRound({
        players: makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]),
        holes: 'front9',
        games: [
          { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
        ],
      })

    /** A is always the hole-1 wolf. `wolfLow` decides which side wins. */
    const hole1 = (choice: string, wolfLow: boolean) => {
      const r = round()
      const log = new EventLog()
      pick(log, 1, choice)
      const partnered = choice === 'p-b'
      log.scoreByHole(
        r,
        {
          A: [wolfLow ? 3 : 5],
          B: [partnered ? (wolfLow ? 3 : 5) : 4],
          C: [4],
          D: [4],
        },
        [1],
      )
      const c = deriveRound(r, log.events).derivations.get('game-1')!.settlement.perPlayerCents
      return [c['p-a'], c['p-b'], c['p-c'], c['p-d']]
    }

    // typed, so swapping two columns is a compile error rather than a
    // confusing assertion failure
    const CASES: [label: string, choice: string, wolfLow: boolean, cents: number[]][] = [
      ['partnered win', 'p-b', true, [100, 100, -100, -100]],
      ['partnered loss', 'p-b', false, [-100, -100, 100, 100]],
      ['lone win', 'lone', true, [600, -200, -200, -200]],
      ['lone loss', 'lone', false, [-600, 200, 200, 200]],
      ['blind win', 'blind', true, [900, -300, -300, -300]],
      ['blind loss', 'blind', false, [-900, 300, 300, 300]],
    ]

    it.each(CASES)('%s', (_label, choice, wolfLow, expected) => {
      const cents = hole1(choice, wolfLow)
      expect(cents).toEqual(expected)
      expect(cents.reduce((a, b) => a! + b!, 0)).toBe(0)
    })

    /**
     * Lone and blind must MIRROR. The bug this replaces was exactly an
     * asymmetry — +$12 to win, −$3 to lose — which made going lone the answer
     * regardless of the golf (MAI-83).
     */
    it('pays a solo wolf the same either way', () => {
      for (const choice of ['lone', 'blind']) {
        const win = hole1(choice, true)
        const lose = hole1(choice, false)
        expect(win.map((c) => -c!)).toEqual(lose)
      }
    })
  })

  /**
   * THE PAIRING THIS RESTS ON.
   *
   * `sideStake` balances for EVEN SIDES or a LONE side — not for any split. A
   * 2-v-3 leaves a unit behind (match.test.ts says so outright), and the only
   * reason Wolf never deals one is that `validateSetup` holds it to exactly
   * four players. That is a pairing between two files, which is the kind that
   * rots: raise `maxPlayers` for the 5-player variant the catalog anticipates
   * and the money silently stops adding up.
   *
   * So this asserts the rule against the roster sizes Wolf ACCEPTS, rather
   * than against the number 4. Widen the engine without generalising the
   * settlement and it fails here.
   */
  describe('balances at every roster it accepts', () => {
    const engine = getEngine('wolf')!

    it('accepts only sizes whose every split balances', () => {
      for (let count = 2; count <= 8; count++) {
        const players = makePlayers(
          ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].slice(0, count).map((name) => ({ name })),
        )
        const config = {
          gameId: 'g',
          type: 'wolf',
          handicap: engine.defaultHandicap(),
          config: { pointCents: 100, rotation: players.map((p) => p.playerId) },
        }
        if (engine.validateSetup(config, players).length > 0) continue

        // every side split this roster can produce: the wolf alone, or paired
        for (const wolfSideSize of [1, 2]) {
          const packSize = count - wolfSideSize
          const balanced =
            wolfSideSize === packSize || wolfSideSize === 1 || packSize === 1
          expect(
            balanced,
            `wolf accepts ${count} players but a ${wolfSideSize}-v-${packSize} hole cannot balance — generalise the settlement before widening the roster`,
          ).toBe(true)
        }
      }
    })
  })
})
