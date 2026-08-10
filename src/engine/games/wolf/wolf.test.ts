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
    expect(d.holeSummary(1)).toEqual(['A :wolf: & B win with A\'s 4']) // wolf side, partnered
    // PACK WIN: the wolf is still named. Winners lead, but a pack win has no
    // wolf in it, so without the losing side here the two names in the money
    // row (C -$1 · D -$1) can't say which of them called the hole.
    expect(d.holeSummary(3)).toEqual(['A & B beat C :wolf: & D — A\'s 4'])
    expect(d.holeSummary(7)).toEqual(['C :wolf: & A win with C\'s 3'])
    // both partners posted the winning 4, so naming either would be a half-truth
    expect(d.holeSummary(8)).toEqual(['D :wolf: & A win with 4'])
    // lone win: one player on the side, so no possessive — "B wins with B's 3"
    // would just say B twice. The cause line carries only the multiplier, since
    // the headline's label already says who and which mode.
    expect(d.holeSummary(2)).toEqual([
      'B :wolf: (lone) wins with 3',
      '↳ lone wolf — the hole doubles',
    ])
    // blind LOSS — the headline names the wolf on the losing side; all three of
    // A, B and C posted the 4, so no possessive
    expect(d.holeSummary(4)).toEqual([
      'A & B & C beat D :wolf-shades: (blind) — 4',
      '↳ blind wolf — the hole triples',
    ])
    // halved: still names the wolf's side (a bare "Halved" would be a
    // regression), and no cause line — nothing moved for the multiplier to
    // explain, and "(lone)" is already in the label
    expect(d.holeSummary(5)).toEqual(['A :wolf: (lone) — halved at 4'])
    // the trailing player takes the last wolf — D, not C, under these totals
    expect(d.holeSummary(9)).toEqual(['D :wolf: & B — halved at 4'])
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
      lines: ['A :wolf: (lone)', 'vs.', 'B & C & D'],
    })
    // lone win: the wolf plays the doubled hole against each of three → 6 stakes
    expect(after.settlement.perPlayerCents['p-a']).toBe(600)
    expect(after.settlement.perPlayerCents['p-b']).toBe(-200)
    // bar recaps the solo win with its mode tag — and stays token-free, since
    // the pinned bar renders `summaryParts` raw
    expect(after.summaryParts).toEqual([{ label: 'H1', value: 'A lone +6' }])
  })

  /**
   * THE CONTRACT OF THE CHANNEL, as a test rather than three paragraphs of
   * prose. `requiredInputs()` keeps an answered request in the list, so its
   * LENGTH is not a count of what is blocking and never becomes zero on a
   * round that is fully declared. Anything asking "is this hole still stuck?"
   * has to filter on `!answered` — the same shape as `openActions` filtering on
   * `!taken`. A future gate that counts the list instead gets a round that can
   * never look settled, and this is what fails when it tries.
   */
  it('answers with a list that is never empty, so its length is not a blocker count', () => {
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
    const inputs = d.requiredInputs()
    // every hole the round has reached is represented…
    expect(inputs.length).toBeGreaterThan(0)
    // …but nothing is blocking: hole 1 is answered, hole 2 is the frontier
    expect(inputs.filter((i) => !i.answered).map((i) => i.hole)).toEqual([2])
    expect(inputs.find((i) => i.hole === 1)?.answered).toBeDefined()
  })

  /**
   * A PARTNERED pick states both sides plainly, with the wolf mark on the
   * PLAYER who holds the tee — no mode word, because there is no mode to
   * explain.
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
      lines: ['A :wolf: & B', 'vs.', 'C & D'],
    })

    // Changing the pick is one more event of the same kind — no retraction,
    // which is why `answered` carries no `undoEventIds`. Last write wins.
    pick(log, 1, 'p-c')
    const after = deriveRound(round, log.events).derivations.get('game-1')!
    expect(after.requiredInputs()[0]!.answered).toEqual({
      value: 'p-c',
      lines: ['A :wolf: & C', 'vs.', 'B & D'],
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
    expect(d.holeSummary(1)).toEqual(['A :wolf: & B win with A\'s 4'])
    // NOTHING AT ALL about the holes they never played — not a verdict, not the
    // teams someone pre-picked off the 2nd tee before the group walked in, not
    // even whose tee it was. Mid-round "Wolf: C" is useful (it is where you are
    // walking); after the walk-in there is nowhere to walk.
    expect(d.holeSummary(2)).toEqual([])
    expect(d.holeSummary(3)).toEqual([])
    // …and the screen is asked to state none of it either
    expect(d.requiredInputs().map((i) => i.hole)).toEqual([1])
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
   * INSIDE THE ROTATION THE STAMP IS INERT. The wolf there is fixed by config
   * and hole index and cannot legitimately move, so the stamp tells us nothing
   * the rotation doesn't — and honouring one would let a corrupted or
   * hand-edited log rewrite whose tee it was.
   */
  it('lets the rotation decide inside it, whatever a pick claims', () => {
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
    // hole 1 is A's by rotation; this claims it was B's
    log.append({
      type: 'game/event',
      gameId: 'game-1',
      kind: 'wolf/pick',
      data: { hole: 1, choice: 'lone', wolf: 'p-b' },
    })

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    // A is the wolf, and the lone call computes against A's 3
    expect(d.holeSummary(1)).toEqual(['A :wolf: (lone) wins with 3', '↳ lone wolf — the hole doubles'])
    expect(d.settlement.perPlayerCents['p-a']).toBe(600)
  })

  /**
   * The one way left to go stale: a partner pick naming this hole's own wolf,
   * which would compute a degenerate [wolf, wolf] side. Reachable from a roster
   * change, or from a pre-MAI-84 log whose derived wolf has since moved.
   */
  it("drops a partner pick that names the hole's own wolf", () => {
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
    // A is the wolf on hole 1, and this rides A with A
    pick(log, 1, 'p-a')

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    // nothing computed, and the prompt is back so the group can re-declare
    expect(Object.values(d.settlement.perPlayerCents).every((c) => c === 0)).toBe(true)
    expect(d.requiredInputs().some((i) => i.hole === 1 && !i.answered)).toBe(true)
    expect(d.holeSummary(1)).toEqual(['Wolf: A'])
  })

  /**
   * WHO THE WOLF WAS IS A THING THAT HAPPENED, NOT A DERIVATION.
   *
   * The trailing-player wolf is provisional while an earlier hole is unfinished,
   * and picking under a provisional one is ordinary: the group is on the 9th tee
   * with someone's 8th still unwritten. The first score on the 9th finalizes the
   * 8th, the totals move, and the derived wolf becomes someone else.
   *
   * Recomputing there would throw away both the declaration and the hole's money
   * — on 17 AND 18 of an ordinary round, since each finalizes on the next one's
   * first score. The stamp the pick carries is the authority instead, so the hole
   * stays exactly as it was played.
   */
  it('keeps a declaration when a finalizing earlier hole moves the derived wolf', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
      ],
    })
    const log = new EventLog()
    // Hole 8 is D's tee. Three players post; D never does, so the hole is not
    // finalized while the 9th has no scores.
    log.append({ type: 'game/event', gameId: 'game-1', kind: 'wolf/pick', data: { hole: 8, choice: 'lone', wolf: 'p-d' } })
    for (const id of ['p-a', 'p-b', 'p-c']) {
      log.append({ type: 'score/set', playerId: id, hole: 8, gross: 4 })
    }

    // 9 holes / 4 players leaves hole 9 off the rotation, so its wolf is the
    // trailing player — and every total is still 0, so it is A on the tie-break.
    const onTheTee = deriveRound(round, log.events).derivations.get('game-1')!
    expect(onTheTee.holeSummary(9)).toEqual(['Wolf: A'])

    // the group declares under that wolf
    log.append({ type: 'game/event', gameId: 'game-1', kind: 'wolf/pick', data: { hole: 9, choice: 'lone', wolf: 'p-a' } })
    const declared = deriveRound(round, log.events).derivations.get('game-1')!
    expect(declared.requiredInputs().find((i) => i.hole === 9)?.answered?.value).toBe('lone')

    // …then the first score on 9 finalizes 8, D's lone loss puts them on −6,
    // and the DERIVED wolf for 9 would now be D
    log.append({ type: 'score/set', playerId: 'p-a', hole: 9, gross: 4 })
    const after = deriveRound(round, log.events).derivations.get('game-1')!
    expect(after.settlement.perPlayerCents['p-d']).toBe(-600)
    // but the 9th was A's tee when they played it, and it stays A's — the
    // declaration survives instead of the panel reverting to a prompt mid-hole
    expect(after.holeSummary(9)).toEqual(['A :wolf: (lone) vs. B & C & D'])
    expect(after.requiredInputs().find((i) => i.hole === 9)?.answered?.value).toBe('lone')
  })

  /**
   * A PLAYED HOLE THAT WAS NEVER DECLARED PAYS NOTHING, and the only place that
   * said so was the hole's own panel — one hole out of eighteen, on a screen
   * you have to already be standing on. Survivable while a missing pick meant
   * "nobody tapped it"; not survivable once the staleness rule can DROP a
   * declaration that was made, on a solo hole worth six or nine stakes.
   *
   * `notes` is the round-level channel for it, and it renders on the standings
   * sheet and the settle screen both.
   */
  it('says on the round when a played hole was never declared', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
      ],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4, 4], B: [5, 5], C: [5, 5], D: [5, 5] }, [1, 2])
    pick(log, 2, 'p-c')

    // MID-ROUND IT SAYS NOTHING, even though hole 1 is finalized and undeclared
    // — the group may still be about to record it, and a round-level "dead
    // money" claim while the prompt is on screen is the nag CTP's note avoids.
    expect(deriveRound(round, log.events).derivations.get('game-1')!.notes).toBeUndefined()

    log.append({ type: 'round/completed' })
    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.notes).toEqual(['Hole 1: no wolf declared — nothing settled there.'])
    // …and it is NOT a settlement line: "No money moved." must stay honest (MAI-40)
    expect(d.settlement.lines.every((l) => !l.label.includes('no wolf'))).toBe(true)
  })

  /**
   * …AND IT DOES NOT ACCUSE A GROUP OF FORGETTING SOMETHING THEY DID. A pick can
   * be refused rather than absent — a partner pick naming the hole's own wolf,
   * reachable on a log written before the stamp existed. "No wolf declared"
   * would be a false statement about that group, so the log decides which
   * sentence is true: `picks` still holds the event even when it was refused.
   */
  it('says which happened when a pick was refused rather than never made', () => {
    const players = makePlayers([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])
    const round = makeRound({
      players,
      holes: 'front9',
      games: [
        { type: 'wolf', config: { pointCents: 100, rotation: ['p-a', 'p-b', 'p-c', 'p-d'] } },
      ],
    })
    const log = new EventLog()
    log.scoreByHole(round, { A: [4, 4], B: [5, 5], C: [5, 5], D: [5, 5] }, [1, 2])
    // hole 1 is A's tee, and this rides A with A — refused
    pick(log, 1, 'p-a')
    // hole 2 is B's tee and simply never got a pick
    log.append({ type: 'round/completed' })

    const d = deriveRound(round, log.events).derivations.get('game-1')!
    expect(d.notes).toEqual([
      'Hole 2: no wolf declared — nothing settled there.',
      'Hole 1: the wolf pick names no valid partner — nothing settled there.',
    ])
  })

  /**
   * …and a completed round stops asking about holes nobody played. The frontier
   * pre-prompt is "the tee you are standing on"; once the group has walked in,
   * nobody is standing on it (MAI-38).
   */
  it('stops pre-prompting the next tee once the round is over', () => {
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

    // mid-round, hole 2 is the tee they are walking to
    expect(
      deriveRound(round, log.events)
        .derivations.get('game-1')!
        .requiredInputs()
        .map((i) => i.hole),
    ).toEqual([1, 2])

    log.append({ type: 'round/completed' })
    // finished on the 1st: hole 2 was never played, so there is nothing to ask
    expect(
      deriveRound(round, log.events)
        .derivations.get('game-1')!
        .requiredInputs()
        .map((i) => i.hole),
    ).toEqual([1])
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
