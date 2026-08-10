import { describe, expect, it } from 'vitest'
import '../../engine/games'
import { deriveRound } from '../../engine/catalog'
import { doubleNine } from '../../engine/core/tees'
import type { Round } from '../../engine/core/types'
import { EventLog, makeCourse, makePlayers, makeRound } from '../../engine/test/harness'
import { NETS_TO_NOTHING, buildSummaryCard, moneyLine } from './summaryCard'

/**
 * The model is the single derivation behind both the settle screen and the
 * shared image, so these assertions are the regression guard for both.
 */

const NBSP_ = '\u00A0'
/** one character = one unit, which is what the painter's pixel font approximates */
const mono = (t: string) => t.length

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

  /**
   * MAI-50. One panel per game is fine at two and a scrolling wall at six, and
   * the shared PNG has a real height budget — so the side bets fold into one
   * panel HERE, in the model, where the settle screen and the painter both read
   * it and so cannot disagree about it.
   */
  describe('side-bet grouping', () => {
    /** A nassau main event with two skins side bets beside it. */
    const roundWithSideBets = () => {
      const round = makeRound({
        players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
        holes: 'front9',
        games: [
          { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
          { type: 'skins', config: { stakeCents: 100, carryover: true } },
          { type: 'skins', config: { stakeCents: 200, carryover: false } },
        ],
      })
      const log = new EventLog(round.id)
      log.scoreByHole(round, { Ben: [3, 4], Al: [4, 4] }, [1, 2])
      return { round, log }
    }

    it('folds several side bets into one panel, main games untouched', () => {
      const { round, log } = roundWithSideBets()
      const c = card(round, log)

      expect(c.games).toHaveLength(2)
      expect(c.games[0]!.name).toBe('Nassau')
      expect(c.games[1]!.name).toBe('Side bets')
      // each side bet keeps its own name as the gold chip on its first line, so
      // the grouped panel still says who won what
      const chips = c.games[1]!.lines.filter((l) => l.label !== '').map((l) => l.label)
      expect(chips).toHaveLength(2)
      expect(chips.every((l) => l.startsWith('Skins'))).toBe(true)
    })

    /**
     * The empty value is the trap: `wrapText('')` returns [], so the painter
     * reserves ZERO height for such a row and draws the next line on top of it.
     * Every grouped row must carry something.
     */
    it('never emits a row with an empty value', () => {
      const { round, log } = roundWithSideBets()
      const grouped = card(round, log).games[1]!
      expect(grouped.lines.length).toBeGreaterThan(0)
      expect(grouped.lines.every((l) => l.value.trim() !== '')).toBe(true)
    })

    it('keeps notes as notes, attributed to the game that said them', () => {
      const round = makeRound({
        players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
        holes: 'front9',
        games: [
          { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
          { type: 'skins', config: { stakeCents: 100, carryover: true } },
          { type: 'skins', config: { stakeCents: 200, carryover: true } },
        ],
      })
      const log = new EventLog(round.id)
      log.scoreByHole(round, { Ben: [4, 4], Al: [4, 4] }, [1, 2]) // all tied
      log.append({ type: 'round/completed' })

      const grouped = card(round, log).games[1]!
      // narration stayed in `notes` — merging it into `lines` is exactly what
      // MAI-40 undid, and would make "No money moved." false
      expect(grouped.notes.length).toBeGreaterThan(0)
      expect(grouped.notes.every((n) => n.startsWith('Skins'))).toBe(true)
      // a side bet that moved nothing still says so rather than vanishing
      expect(grouped.lines.some((l) => l.value === 'No money moved.')).toBe(true)
    })

    it('does NOT group a lone side bet — that saves no space and costs detail', () => {
      const round = makeRound({
        players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
        holes: 'front9',
        games: [
          { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
          { type: 'skins', config: { stakeCents: 100, carryover: true } },
        ],
      })
      const log = new EventLog(round.id)
      log.scoreByHole(round, { Ben: [3, 4], Al: [4, 4] }, [1, 2])

      const c = card(round, log)
      expect(c.games.map((g) => g.name)).toEqual(['Nassau', 'Skins'])
    })

    it('does NOT group a round that is only side bets', () => {
      // two "either" games and nothing else: roleOf makes the first the main
      // event, so there is no all-side round to collapse in the first place
      const round = makeRound({
        players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
        holes: 'front9',
        games: [
          { type: 'skins', config: { stakeCents: 100, carryover: true } },
          { type: 'skins', config: { stakeCents: 200, carryover: true } },
        ],
      })
      const log = new EventLog(round.id)
      log.scoreByHole(round, { Ben: [3, 4], Al: [4, 4] }, [1, 2])

      expect(card(round, log).games).toHaveLength(2)
    })

    /** The height budget in the form that is actually testable: panel count. */
    it('holds an eight-game round to two panels', () => {
      const round = makeRound({
        players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
        holes: 'front9',
        games: [
          { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
          ...Array.from({ length: 7 }, (_, i) => ({
            type: 'skins',
            config: { stakeCents: 100 + i, carryover: true },
          })),
        ],
      })
      const log = new EventLog(round.id)
      log.scoreByHole(round, { Ben: [3, 4], Al: [4, 4] }, [1, 2])

      expect(card(round, log).games).toHaveLength(2)
    })
  })

  /**
   * MAI-88 — THE PROPERTY THE WHOLE TIER EXISTS FOR. Every panel's money must
   * add up to FINAL STANDINGS, or the decomposition is a lie and the reader is
   * worse off than with no numbers at all.
   *
   * The round is the one that prompted the ticket: a Nassau whose halves
   * cancel, beside a side bet that moves everything.
   */
  it('per-game money sums to the standings, game by game and player by player', () => {
    const round = makeRound({
      players: makePlayers([
        { name: 'John' },
        { name: 'Ben' },
        { name: 'Grant' },
        { name: 'Mike' },
      ]),
      holes: 'front9',
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: { a: ['p-john', 'p-ben'], b: ['p-grant', 'p-mike'] }, autoPress: false } },
        { type: 'ctp', config: { stakeCents: 200 } },
      ],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, {
      John: [4, 4, 5, 3, 4, 4, 3, 5, 4],
      Ben: [4, 4, 5, 3, 4, 4, 3, 5, 4],
      Grant: [4, 4, 5, 3, 4, 4, 3, 5, 4],
      Mike: [4, 4, 5, 3, 4, 4, 3, 5, 4],
    })
    // par 3s on this card are holes 4 and 7
    log.append({ type: 'game/event', gameId: 'game-2', kind: 'ctp/award', data: { hole: 4, playerId: 'p-john' } })
    log.append({ type: 'game/event', gameId: 'game-2', kind: 'ctp/award', data: { hole: 7, playerId: 'p-john' } })
    log.append({ type: 'round/completed' })

    const c = card(round, log)

    const summed = new Map<string, number>()
    for (const panel of c.games) {
      for (const m of panel.money) {
        summed.set(m.playerId, (summed.get(m.playerId) ?? 0) + m.cents)
      }
      // never a $0 row — that is what the empty case is for
      expect(panel.money.every((m) => m.cents !== 0)).toBe(true)
      // richest first, like the standings above it
      expect([...panel.money].sort((a, b) => b.cents - a.cents)).toEqual(panel.money)
    }
    for (const s of c.standings) {
      expect(summed.get(s.playerId) ?? 0, `${s.name}`).toBe(s.cents)
    }

    // and the case that prompted the ticket: every hole halved, so the Nassau
    // moved nothing at all and has to SAY so rather than sit there silently
    const nassau = c.games.find((g) => g.name === 'Nassau')!
    expect(nassau.lines.length).toBeGreaterThan(0)
    expect(nassau.money).toEqual([])
    expect(moneyLine(mono, nassau.money)).toBe(NETS_TO_NOTHING)

    const ctp = c.games.find((g) => g.name === 'Closest to the Pin')!
    expect(ctp.money.map((m) => `${m.name} ${m.cents}`)).toEqual([
      'John 1200',
      'Ben -400',
      'Grant -400',
      'Mike -400',
    ])
  })

  /**
   * The painter word-wraps on spaces, so a name and its amount must be one
   * unbreakable token — "John" stranded above "+$10" is worse than showing no
   * money at all. Same rule `closeMargin` follows for "2 up".
   */
  it('never lets a name break away from its amount', () => {
    const line = moneyLine(mono, [
      { playerId: 'p-a', name: 'John', cents: 1000 },
      { playerId: 'p-b', name: 'Mike', cents: -1000 },
    ])
    // Spelled with an escape so the assertion is legible: the whole point is a
    // character you cannot see, and a test that depends on one nobody can read
    // is a test nobody can maintain.
    const NBSP = '\u00A0'
    expect(line).toBe(`John${NBSP}+$10 \u00B7 Mike${NBSP}-$10`)
    // breaks BETWEEN players, never inside one
    expect(line.split(' ')).toEqual([`John${NBSP}+$10`, '\u00B7', `Mike${NBSP}-$10`])
    // a PLAIN space between a name and its amount is the bug this prevents
    expect(line).not.toMatch(/John \+/)
    // A NAME WITH A SPACE IN IT is the case that makes the pair — not the
    // join — the unbreakable unit. Joining only name-to-amount left the wrap
    // free to break inside the name instead, stranding "Ben" on its own line
    // above "Norman +$10", which is the same failure one word earlier.
    const twoWord = moneyLine(mono, [{ playerId: 'p-c', name: 'Ben Norman', cents: 1000 }])
    expect(twoWord).toBe(`Ben${NBSP}Norman${NBSP}+$10`)
    expect(twoWord.split(' ')).toHaveLength(1)

    // and never an empty value: `wrapText('')` returns [], so the painter would
    // reserve zero height and draw the next line straight on top of it
    expect(moneyLine(mono, []).length).toBeGreaterThan(0)
  })

  it('sums the grouped side-bets panel across the games it folds', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
        { type: 'ctp', config: { stakeCents: 200 } },
        { type: 'ctp', config: { stakeCents: 300 } },
      ],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ann: [4, 4, 5, 3], Bob: [5, 5, 6, 4] }, [1, 2, 3, 4])
    for (const gameId of ['game-2', 'game-3']) {
      log.append({ type: 'game/event', gameId, kind: 'ctp/award', data: { hole: 4, playerId: 'p-ann' } })
    }
    log.append({ type: 'round/completed' })

    const c = card(round, log)
    const grouped = c.games.find((g) => g.name === 'Side bets')!
    // $2 + $3 from Bob, folded into one line rather than two panels
    expect(grouped.money).toEqual([
      { playerId: 'p-ann', name: 'Ann', cents: 500 },
      { playerId: 'p-bob', name: 'Bob', cents: -500 },
    ])
  })

  /**
   * MAI-88, review round 1. Money can MOVE and still leave everyone level, so
   * the empty case had to stop claiming otherwise: a grouped side-bets panel
   * whose two games cancel prints both payouts and then this line, and
   * "nothing moved" directly beneath two payments is simply false.
   */
  it('says a panel NETS to nothing, even when it lists real payouts', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [
        { type: 'nassau', config: { stakeCents: 500, teams: null, autoPress: false } },
        { type: 'skins', config: { stakeCents: 200, carryover: false } },
        { type: 'ctp', config: { stakeCents: 200 } },
      ],
    })
    const log = new EventLog(round.id)
    // hole 1 (par 4) to Bob outright — that is the skin; hole 4 is the par 3
    log.scoreByHole(round, { Ann: [5, 4, 5, 3], Bob: [4, 4, 5, 3] }, [1, 2, 3, 4])
    log.append({ type: 'game/event', gameId: 'game-3', kind: 'ctp/award', data: { hole: 4, playerId: 'p-ann' } })
    log.append({ type: 'round/completed' })

    const c = card(round, log)
    const grouped = c.games.find((g) => g.name === 'Side bets')!
    // Bob took the skin, Ann took the CTP, both $2 — real money, both ways
    expect(grouped.lines.length).toBeGreaterThan(0)
    expect(grouped.money).toEqual([])
    expect(moneyLine(mono, grouped.money)).toBe(NETS_TO_NOTHING)
    expect(NETS_TO_NOTHING).not.toMatch(/nothing moved/)
    // the side bets contributed nothing to anyone's total — which is exactly
    // what the line has to convey, and what 'nothing moved' got wrong
    for (const m of grouped.money) expect(m.cents).toBe(0)
    expect(c.games.find((g) => g.name === 'Nassau')!.money.length).toBeGreaterThan(0)
  })

  /** The unbreakable-pair contract, asserted through the one function
   *  production actually calls — an unfitted line is just `max = Infinity`. */
  it('emits one unbreakable token per player, with no break inside it', () => {
    const line = moneyLine(mono, [
      { playerId: 'p-a', name: 'Ben Norman', cents: 1000 },
      { playerId: 'p-b', name: 'Rob', cents: -1000 },
    ])
    const tokens = line.split(' ').filter((t) => t !== '\u00B7')
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toBe(`Ben${NBSP_}Norman${NBSP_}+$10`)
  })

  /**
   * MAI-88, review round 2. A pair too wide for the column has no break left in
   * it by construction, so SOMETHING has to give — and it must not be the
   * money. Truncating the whole token ate the amount from the right and left a
   * player showing no money at all beside neighbours who had theirs, which is
   * the exact absence this tier exists to remove.
   *
   * Testable at all only because the fitting takes its measurer as an argument,
   * the same trick `wrapText` uses to stay out of the untestable painter.
   */
  describe('fitting a money line to a column', () => {
    const wide = [
      { playerId: 'p-a', name: 'Christopher Vandenberghe-Smythe', cents: 1200 },
      { playerId: 'p-b', name: 'Ann', cents: -1200 },
    ]

    it('shortens the name and never the amount', () => {
      const line = moneyLine(mono, wide, 20)
      for (const token of line.split(' ')) {
        if (token === '\u00B7') continue
        expect(token, token).toMatch(/[+-]\$\d+$/)
      }
      expect(line).toContain('…')
      expect(line).toContain(`+$12`)
      expect(line).toContain(`-$12`)
    })

    it('keeps every pair inside the column, at every width', () => {
      for (let max = 6; max <= 60; max++) {
        for (const token of moneyLine(mono, wide, max).split(' ')) {
          if (token === '\u00B7') continue
          expect(token.length, `"${token}" at max=${max}`).toBeLessThanOrEqual(max)
        }
      }
    })

    it('shows the money bare rather than drop a player entirely', () => {
      // narrower than the amount plus one glyph plus the marker
      const line = moneyLine(mono, wide, 5)
      expect(line).toContain('+$12')
      expect(line).toContain('-$12')
    })

    it('leaves a pair that already fits completely alone', () => {
      expect(moneyLine(mono, [{ playerId: 'p-a', name: 'Ann', cents: 500 }], 100)).toBe(
        `Ann${NBSP_}+$5`,
      )
    })
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

  /**
   * A round that teed off on 10 (MAI-41).
   *
   * The halves are the nines WALKED, so the top table is 10–18 — the same
   * order the money ledger reads in and the nassau bets settled in. And the
   * subtitle has to say where it started, or the image shows an eighteen whose
   * first column is hole 10 with nothing explaining it.
   */
  it('lays a wrapped round out in walk order and says where it teed off', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      startHole: 10,
      games: [],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: Array(18).fill(4), Al: Array(18).fill(5) })

    const c = card(round, log)
    expect(c.subtitle).toBe('18 holes from 10 · 18 Jul 2026')
    expect(c.cards[0]!.holes).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18])
    expect(c.cards[1]!.holes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    // pars follow their holes, not their position
    expect(c.cards[1]!.pars).toEqual([4, 4, 5, 3, 4, 4, 3, 5, 4])
  })

  /** …and an ordinary round says nothing extra, so the image is unchanged. */
  it('leaves the subtitle alone for a round that started where its range says', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ben' }, { name: 'Al' }]),
      holes: 'back9',
      games: [],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ben: [4], Al: [5] }, [10])

    expect(card(round, log).subtitle).toBe('9 holes · 18 Jul 2026')
  })
})

/**
 * THE SIDE-BETS PANEL SAYS WHAT HAPPENED TO THE MONEY, ONCE.
 *
 * Each block is already headed by the game's own label, so a settlement line
 * repeating it — "Hole 4 — Ben closest to the pin" under CLOSEST TO THE PIN —
 * spends the card's width saying nothing. And Snake shipped `detailLines` on a
 * settled round, which is what makes a panel render as a LEDGER instead of its
 * money lines: the card showed "Snake · Mike · $32", a number whose SIGN the
 * reader cannot recover. He pays it, to each of the others.
 */
describe('side-bet panels', () => {
  const settled = () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }, { name: 'Cal' }, { name: 'Dee' }]),
      holes: 'front9',
      games: [
        { type: 'snake', config: { potCents: 3200, doubling: false } },
        { type: 'ctp', config: { stakeCents: 200 } },
        { type: 'longDrive', config: { stakeCents: 200, holes: 'par5s' } },
      ],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(
      round,
      { Ann: [4, 4, 4, 3, 4], Bob: [4, 4, 4, 3, 4], Cal: [4, 4, 4, 3, 4], Dee: [4, 4, 4, 3, 4] },
      [1, 2, 3, 4, 5],
    )
    const g = (i: number) => round.games[i]!.gameId
    log.append({ type: 'game/event', gameId: g(0), kind: 'snake/bite', data: { hole: 2, playerId: 'p-bob' } })
    log.append({ type: 'game/event', gameId: g(1), kind: 'ctp/award', data: { hole: 4, playerId: 'p-ann' } })
    log.append({ type: 'game/event', gameId: g(2), kind: 'longDrive/award', data: { hole: 3, playerId: 'p-cal' } })
    log.append({ type: 'round/completed' })
    return card(round, log)
  }

  it('states the snake as a payment, not as an unsigned number', () => {
    const snake = settled().games.find((g) => g.name === 'Snake')!
    // MONEY LINES, not the live-position ledger — which is what let an
    // unsigned "Mike · $32" onto the card in the first place
    expect(snake.kind).toBe('lines')
    expect(snake.lines.map((l) => l.value)).toEqual(['Bob pays $32 to each of 3 others'])
    // …and what it cost the player it names: the pot to each of three, NEGATIVE,
    // which is what the screen paints red. Not the per-head $32 — the panel has
    // to reconcile with the totals underneath it.
    expect(snake.lines[0]!.amountCents).toBe(-9600)
  })

  it('does not repeat the game name inside its own block', () => {
    const c = settled()
    expect(c.games.find((g) => g.name === 'Closest to the Pin')!.lines.map((l) => l.value)).toEqual([
      'Hole 4 — Ann',
    ])
    expect(c.games.find((g) => g.name === 'Long Drive')!.lines.map((l) => l.value)).toEqual([
      'Hole 3 — Cal',
    ])
  })

  /** A hole a player WON shows what they made, positive, which the screen
   *  paints green — $2 from each of the other three. */
  it('shows what each award line made the player it names', () => {
    const c = settled()
    expect(c.games.find((g) => g.name === 'Closest to the Pin')!.lines[0]!.amountCents).toBe(600)
    expect(c.games.find((g) => g.name === 'Long Drive')!.lines[0]!.amountCents).toBe(600)
  })

  /**
   * HEADS-UP IS WHY THE ENGINE DECLARES THIS instead of the model picking the
   * biggest movement out of `perPlayerCents`. With two players the winner's
   * gain and the loser's loss are equal and opposite, so any tie-break over the
   * numbers alone would eventually put a green +$5 on a line reading "A pays $5".
   */
  it('gets the sign right heads-up, where the two movements are equal', () => {
    const round = makeRound({
      players: makePlayers([{ name: 'Ann' }, { name: 'Bob' }]),
      holes: 'front9',
      games: [{ type: 'snake', config: { potCents: 500, doubling: false } }],
    })
    const log = new EventLog(round.id)
    log.scoreByHole(round, { Ann: [4, 4], Bob: [4, 4] }, [1, 2])
    log.append({
      type: 'game/event',
      gameId: round.games[0]!.gameId,
      kind: 'snake/bite',
      data: { hole: 2, playerId: 'p-ann' },
    })
    log.append({ type: 'round/completed' })

    const snake = card(round, log).games[0]!
    expect(snake.lines[0]!.value).toBe('Ann pays $5')
    expect(snake.lines[0]!.amountCents).toBe(-500)
  })
})
