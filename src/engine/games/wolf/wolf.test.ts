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
    // NARRATION IS ONE SENTENCE: who won the hole, and with what. The per-player
    // swing used to be enumerated here, which the ledger prints again as cash
    // directly underneath and the standings sheet again as points (MAI-84).
    // Gross round, so the scores are bare numbers rather than "net 4".
    //
    // Hand-derived from the card above, one per outcome shape:
    expect(d.holeSummary(1)).toEqual(['(W) A & B win with A\'s 4']) // wolf side, partnered
    expect(d.holeSummary(3)).toEqual(['A & B win with A\'s 4']) // pack, partnered
    expect(d.holeSummary(7)).toEqual(['(W) C & A win with C\'s 3'])
    // both partners posted the winning 4, so naming either would be a half-truth
    expect(d.holeSummary(8)).toEqual(['(W) D & A win with 4'])
    // lone win: one player on the side, so no possessive — "B wins with B's 3"
    // would just say B twice. The cause line names the wolf and the multiplier.
    expect(d.holeSummary(2)).toEqual([
      ':wolf: B (lone) wins with 3',
      '↳ B went lone — the hole doubles',
    ])
    // blind LOSS — the wolf is not in the headline, so the cause line is what
    // names them; all three of A, B, C posted the 4, so no possessive
    expect(d.holeSummary(4)).toEqual([
      'A & B & C win with 4',
      '↳ D went blind — the hole triples',
    ])
    // halved: still names the wolf's side (a bare "Halved" would be a
    // regression), and no cause line — nothing moved for the multiplier to
    // explain, and "(lone)" is already in the label
    expect(d.holeSummary(5)).toEqual([':wolf: A (lone) — halved at 4'])
    // the trailing player takes the last wolf — D, not C, under these totals
    expect(d.holeSummary(9)).toEqual(['(W) D & B — halved at 4'])
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
    // nothing is answered yet, so both are the blocking kind
    expect(inputs.every((i) => i.answered === undefined)).toBe(true)
    // no points until the pick lands
    expect(Object.values(d.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)

    pick(log, 1, 'lone')
    const after = deriveRound(round, log.events).derivations.get('game-1')!
    // THE ANSWERED REQUEST STAYS (MAI-84). Hole 1 no longer blocks, but it
    // remains in the list carrying the teams it recorded, so the screen can
    // state them and offer to change them. Hole 2 is still blocking.
    const then = after.requiredInputs()
    expect(then.map((i) => i.hole)).toEqual([1, 2])
    expect(then[1]!.answered).toBeUndefined()
    expect(then[0]!.answered).toEqual({
      value: 'lone',
      // the word rides with the picture: a 16px glyph can't teach "lone"
      lines: [':wolf: A (lone)', 'vs.', 'B & C & D'],
    })
    // lone win: the wolf plays the doubled hole against each of three → 6 stakes
    expect(after.settlement.perPlayerCents['p-a']).toBe(600)
    expect(after.settlement.perPlayerCents['p-b']).toBe(-200)
    // bar recaps the solo win with its mode tag — and stays token-free, since
    // the pinned bar renders `summaryParts` raw
    expect(after.summaryParts).toEqual([{ label: 'H1', value: 'A lone +6' }])
  })

  /**
   * A PARTNERED pick states both sides plainly — `(W)` marks the wolf, and
   * there is no glyph because there is no mode to explain.
   */
  it('states the teams for a partnered pick, and re-picking replaces them', () => {
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
    pick(log, 1, 'p-b')

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.requiredInputs()[0]!.answered).toEqual({
      value: 'p-b',
      lines: ['(W) A & B', 'vs.', 'C & D'],
    })

    // Changing the pick is one more event of the same kind — no retraction,
    // which is why `answered` carries no `undoEventIds`. Last write wins.
    pick(log, 1, 'p-c')
    const after = deriveRound(round, log.events).derivations.get('game-1')!
    expect(after.requiredInputs()[0]!.answered).toEqual({
      value: 'p-c',
      lines: ['(W) A & C', 'vs.', 'B & D'],
    })
    // and the money follows the correction: A+C (4) beat B,D (5)
    expect(after.settlement.perPlayerCents).toEqual({
      'p-a': 100,
      'p-c': 100,
      'p-b': -100,
      'p-d': -100,
    })
  })

  /**
   * MAI-38, applied to Wolf. `ctx.finalized` goes true for EVERY hole the
   * moment the round completes, so a group that finishes on the 2nd would have
   * had holes 3–9 reported as halved — a result for holes nobody played.
   */
  it('never reports a result for a hole nobody played', () => {
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
    pick(log, 1, 'p-b')
    // a pick can exist on a hole that never gets played — the wolf is prompted
    // off the tee, and then the group walks in
    pick(log, 2, 'lone')
    log.append({ type: 'round/completed' })

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.holeSummary(1)).toEqual(['(W) A & B win with A\'s 4'])
    // the teams, not a verdict
    expect(d.holeSummary(2)).toEqual([':wolf: B (lone) vs A & C & D'])
    // no pick either: just whose tee it is
    expect(d.holeSummary(3)).toEqual(['Wolf: C'])
    // AND THE BAR, which is the half that was missed the first time round: the
    // fix belongs in `derive` (an unplayed hole is pending, not halved), not in
    // each narration channel, or the recap keeps saying it after the ledger
    // stops. h2 is skipped and the bar falls back to the last hole played.
    expect(d.summaryParts).toEqual([{ label: 'H1', value: 'A & B +1' }])
    // and no money moved on the holes nobody played
    expect(d.settlement.perPlayerCents).toEqual({
      'p-a': 100,
      'p-b': 100,
      'p-c': -100,
      'p-d': -100,
    })
  })

  /**
   * A PICK BELONGS TO THE WOLF WHO MADE IT.
   *
   * On trailing-player holes the wolf is whoever has fewest points, so a score
   * correction can hand the role to someone else after a pick was recorded. A
   * partner pick shows its own staleness — it names the new wolf, or names
   * nobody. A lone or blind declaration does not, and it silently becomes
   * someone else's call: harmless while nothing showed it, and a lie the moment
   * the screen started saying "D went blind" (MAI-84). So the pick records the
   * wolf it was made under.
   */
  it('drops a solo declaration when the wolf it was made under has changed', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
      ],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [3], B: [5], C: [5], D: [5] }, [1])
    // A is the wolf on hole 1, but this says it was declared under B
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'wolf/pick',
      data: { hole: 1, choice: 'lone', wolf: 'p-b' },
    })

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    // stale: nothing computed, and the prompt is back so the group can re-declare
    expect(Object.values(d.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
    expect(d.requiredInputs().some((i) => i.hole === 1 && !i.answered)).toBe(true)
    expect(d.holeSummary(1)).toEqual(['Wolf: A'])
  })

  it('honours a pick recorded before the wolf was stamped on it', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
      ],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [3], B: [5], C: [5], D: [5] }, [1])
    // no `wolf` key — every pick in every round played before MAI-84. Absence
    // means we cannot know, NOT that it disagrees.
    pick(log, 1, 'lone')

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.perPlayerCents['p-a']).toBe(600)

    // …and a re-pick from such a build CLEARS the stamp rather than inheriting
    // the earlier event's, which would attribute the new call to the old wolf
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'wolf/pick',
      data: { hole: 1, choice: 'blind', wolf: 'p-a' },
    })
    pick(log, 1, 'lone')
    const after = deriveRound(round, log.events).derivations.get('game-1')!
    expect(after.settlement.perPlayerCents['p-a']).toBe(600)
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
        if (engine.validateSetup(config, players, []).length > 0) continue

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
