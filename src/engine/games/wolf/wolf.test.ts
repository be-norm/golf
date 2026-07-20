import { describe, expect, it } from 'vitest'
import '../index'
import { deriveRound } from '../../catalog'
import { EventLog, makePlayers, makeRound } from '../../test/harness'

function pick(log: EventLog, hole: number, choice: string) {
  log.append({ type: 'game/event', gameId: 'game-1', kind: 'wolf/pick', data: { hole, choice } })
}

describe('wolf — golden fixture (hand-verified)', () => {
  /**
   * Gross wolf, $1/pt, front 9, rotation A,B,C,D (8 rotation holes + 1 trailing).
   * h1 A+B beat pack → A+2 B+2 · h2 B lone wins → B+4
   * h3 C+D lose → A+3 B+3 · h4 D blind loses → A+2 B+2 C+2
   * h5 A lone, halved · h6 B+C lose → A+3 D+3
   * h7 C+A win → C+2 A+2 · h8 D+A win → D+2 A+2
   * h9: fewest points is C (4) → C is wolf; C+B vs A,D halved.
   * Points: A14 B11 C4 D5 (Σ34). money = 100×(4·p − 34):
   * A +$22, B +$10, C −$18, D −$14.
   */
  it('rotation, lone/blind multipliers, trailing-player wolf, pairwise settlement', () => {
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
    pick(log, 9, 'p-b') // trailing-player wolf C rides with B

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.settlement.perPlayerCents).toEqual({
      'p-a': 2200,
      'p-b': 1000,
      'p-c': -1800,
      'p-d': -1400,
    })
    expect(d.holeSummary(9)[0]).toContain('Wolf C')
    expect(d.holeSummary(2)[0]).toContain('B +4')
    expect(d.holeSummary(4)[0]).toContain('+2')
    // bar recaps the latest decided hole (h9: C rides with B, C+B win → 2 each)
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
    expect(after.settlement.perPlayerCents['p-a']).toBe(1200) // lone win: 100×(4·4 − 4)
    // bar recaps the solo win with its mode tag
    expect(after.summaryParts).toEqual([{ label: 'H1', value: 'A lone +4' }])
  })
})
