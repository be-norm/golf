import { describe, expect, it } from 'vitest'
import '../../engine/games'
import { deriveRound } from '../../engine/catalog'
import { doubleNine } from '../../engine/core/tees'
import type { Round } from '../../engine/core/types'
import { EventLog, makeCourse, makePlayers, makeRound } from '../../engine/test/harness'
import { buildSummaryCard } from './summaryCard'

/**
 * The model is the single derivation behind both the settle screen and the
 * shared image, so these assertions are the regression guard for both.
 */

const card = (round: Round, log: EventLog) => {
  const { ctx, derivations } = deriveRound(round, log.events)
  return buildSummaryCard(round, ctx, derivations)
}

describe('buildSummaryCard', () => {
  it('ranks standings, names the leader and nets out who collects', () => {
    // Front 9, gross skins at $1, carryover on. Pars 4,4,5,3,4,4,3,5,4.
    // H1 Ben 3 vs Al 4 vs Cy 4 → Ben wins 1 skin.
    // H2 all 4 → tie, carries.
    // H3 Al 5 vs Ben 6 vs Cy 6 → Al wins 2 skins (this + the carry).
    // Ben +1 -0.66… is not integral, so use the engine's own numbers below;
    // what this test pins is ordering, the leader flag and the netting.
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }, { name: 'Cy' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 300, carryover: true } }],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(
      round,
      { Ben: [3, 4, 6], Al: [4, 4, 5], Cy: [4, 4, 6] },
      [1, 2, 3],
    )

    const c = card(round, log)

    expect(c.course).toBe('Test National')
    expect(c.subtitle).toBe('9 holes · 18 Jul 2026')

    // sorted richest-first, full roster present, zero-sum
    expect(c.standings.map((s) => s.name)).toEqual(['Al', 'Ben', 'Cy'])
    expect(c.standings.reduce((a, s) => a + s.cents, 0)).toBe(0)
    expect(c.standings[0]!.leader).toBe(true)
    expect(c.standings.slice(1).every((s) => !s.leader)).toBe(true)

    // Cy won nothing and paid both winners
    expect(c.standings.find((s) => s.name === 'Cy')!.cents).toBeLessThan(0)
    const owed = c.settle.flatMap((s) => s.from.filter((f) => f.name === 'Cy'))
    expect(owed.length).toBeGreaterThan(0)
    for (const s of c.settle) {
      expect(s.from.reduce((a, f) => a + f.cents, 0)).toBe(s.totalCents)
    }
  })

  it('leaves no leader when the round is all square', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: false } }],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: [4, 4], Al: [4, 4] }, [1, 2])

    const c = card(round, log)
    expect(c.standings.every((s) => s.cents === 0)).toBe(true)
    expect(c.standings.every((s) => !s.leader)).toBe(true)
    expect(c.settle).toEqual([])
  })

  it('carries the Nassau per-bet ledger through as game lines', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      games: [
        {
          type: 'nassau',
          config: { stakeCents: 500, teams: null, autoPress: false },
          handicap: { mode: 'net', allowancePct: 90, reference: 'offLow' },
        },
      ],
    })
    const log = new EventLog(round.id)
    // Ben wins the front outright, the back is halved
    const ben = [3, 3, 4, 3, 3, 3, 3, 4, 3, 4, 5, 3, 4, 4, 5, 3, 4, 4]
    const al = [4, 4, 5, 3, 4, 4, 3, 5, 4, 4, 5, 3, 4, 4, 5, 3, 4, 4]
    log.scoreByHole(round, { Ben: ben, Al: al })

    const c = card(round, log)
    const nassau = c.games[0]!
    expect(nassau.name).toBe('Nassau')
    expect(nassau.allowance).toBe('90%')
    expect(nassau.kind).toBe('ledger')
    // F9 / B9 / 18 all present, as labelled bets rather than raw money lines
    expect(nassau.lines.map((l) => l.label)).toEqual(
      expect.arrayContaining(['F9', 'B9', '18']),
    )
    expect(nassau.lines.every((l) => l.value.length > 0)).toBe(true)
    // framed with a colon, not parentheses: once a round can hold two of a
    // type the label carries its own — "(Skins (net))" reads as a typo
    expect(c.strokeNote).toBe('underline = handicap stroke: Nassau')
  })

  it('carries a Nassau close through to the settle screen and the share card', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      games: [{ type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } }],
    })
    const log = new EventLog(round.id)
    // Ben wins h1–h3, h4–h7 halved → the front is over 3&2 on hole 7
    log.scoreByHole(round, { Ben: [4, 4, 4, 4, 4, 4, 4], Al: [5, 5, 5, 4, 4, 4, 4] }, [1, 2, 3, 4, 5, 6, 7])

    const nassau = card(round, log).games[0]!
    expect(nassau.kind).toBe('ledger')
    // the margin reaches the shared image intact — and as ONE token, since the
    // painter word-wraps on spaces and "3 & 2" could break across two lines.
    // Matched as a MARGIN pattern, not a bare ' & ': team sides legitimately
    // render "Ann & Bob", so a blanket ampersand ban would both prove nothing
    // here and fail on the first 2v2 fixture anyone adds.
    expect(nassau.lines.find((l) => l.label === 'F9')!.value).toBe('Ben wins 3&2')
    expect(nassau.lines.every((l) => !/\d\s+&\s+\d/.test(l.value))).toBe(true)
  })

  it('names a dead skins carry, which has no ledger to hide in', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: [4, 4], Al: [4, 4] }, [1, 2]) // both tied
    log.append({ type: 'round/completed' })

    const skins = card(round, log).games[0]!
    // Nothing was won, so the money panel is genuinely empty and the screen's
    // "No money moved." is TRUE — while the note underneath still accounts for
    // the two skins the group put up. Before MAI-40 the note was a $0 money
    // line, which made "no money moved" false on a round where none did.
    expect(skins.kind).toBe('lines')
    expect(skins.lines).toEqual([])
    expect(skins.notes).toEqual(['2 skins died unwon — no hole left to win them'])
  })

  it('falls back to settlement lines for games without a ledger', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: true } }],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: [3, 4], Al: [4, 4] }, [1, 2])

    const c = card(round, log)
    expect(c.games[0]!.name).toBe('Skins')
    expect(c.games[0]!.allowance).toBeUndefined()
    // no detailLines → money lines, label-less, and flagged as such so neither
    // renderer has to infer the layout from whether a label happens to be set
    expect(c.games[0]!.kind).toBe('lines')
    expect(c.games[0]!.lines.every((l) => l.label === '')).toBe(true)
    expect(c.games[0]!.lines[0]!.value).toMatch(/Hole 1/)
  })

  it('splits 18 holes into two halves with pars, totals and stroke flags', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben', ch: 18 }, { name: 'Al', ch: 0 }]),
      games: [
        {
          type: 'skins',
          config: { stakeCents: 100, carryover: false },
          handicap: { mode: 'net', allowancePct: 100, reference: 'absolute' },
        },
      ],
    })
    const log = new EventLog(round.id)
    const scores = Array.from({ length: 18 }, () => 4)
    log.scoreByHole(round, { Ben: scores, Al: scores })

    const c = card(round, log)
    expect(c.cards).toHaveLength(2)
    expect(c.cards[0]!.holes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(c.cards[1]!.holes).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18])
    expect(c.cards[0]!.pars).toEqual([4, 4, 5, 3, 4, 4, 3, 5, 4])
    expect(c.cards[0]!.parTotal).toBe(36)
    expect(c.cards[0]!.title).toBeUndefined()

    const benFront = c.cards[0]!.rows.find((r) => r.name === 'Ben')!
    expect(benFront.scores).toEqual(scores.slice(0, 9))
    expect(benFront.total).toBe(36)
    // an 18 handicap gets a stroke on every hole; scratch Al gets none
    expect(benFront.strokes.every(Boolean)).toBe(true)
    expect(c.cards[0]!.rows.find((r) => r.name === 'Al')!.strokes.some(Boolean)).toBe(false)
  })

  it('leaves unplayed holes undefined rather than zero', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      holes: 'front9',
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: false } }],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: [4, 5], Al: [4, 4] }, [1, 2])

    const c = card(round, log)
    const ben = c.cards[0]!.rows.find((r) => r.name === 'Ben')!
    expect(ben.scores).toEqual([4, 5, undefined, undefined, undefined, undefined, undefined, undefined, undefined])
    expect(ben.total).toBe(9)
  })

  it('titles each loop when a nine is played twice', () => {
    const nine = makeCourse([4, 4, 5, 3, 4, 4, 3, 5, 4], [5, 13, 1, 9, 17, 3, 11, 7, 15])
    const round = makeRound({
      course: doubleNine(nine),
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      games: [{ type: 'skins', config: { stakeCents: 100, carryover: false } }],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: Array.from({ length: 18 }, () => 4), Al: Array.from({ length: 18 }, () => 5) })

    const c = card(round, log)
    expect(c.cards.map((h) => h.title)).toEqual(['1st time round', '2nd time round'])
  })

  it('survives a round with no games at all', () => {
    // only setup enforces at least one game; an imported round may carry none
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      holes: 'front9',
      games: [],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: [4, 5], Al: [4, 4] }, [1, 2])

    const c = card(round, log)
    expect(c.games).toEqual([])
    expect(c.settle).toEqual([])
    expect(c.strokeNote).toBeUndefined()
    expect(c.standings.every((s) => s.cents === 0)).toBe(true)
    expect(c.cards[0]!.rows.every((r) => r.strokes.every((s) => s === false))).toBe(true)
  })
})
