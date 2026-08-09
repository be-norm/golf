import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { motion, AnimatePresence } from 'motion/react'
import { eventStore } from '../../db/eventStore'
import { roundRepo } from '../../db/repos'
import { effectiveEvents, isCompleted } from '../../engine/core/replay'
import { combineSettlements, formatCentsSigned } from '../../engine/core/money'
import { getEngine } from '../../engine/catalog'
import type {
  Award,
  GameAction,
  GameActionCopy,
  GameDerivation,
  GameEventOffer,
  InputRequest,
} from '../../engine/catalog'
import type { EventDraft } from '../../engine/core/events'
import type { GameConfig, Round } from '../../engine/core/types'
import { gameLabel } from '../../engine/label'
import { partitionByRole, shouldGroupSideBets, strokeGame } from '../../lib/gameRoles'
import { ActionsSheet } from './ActionsSheet'
import { AwardGrid } from './AwardGrid'
import { Sheet } from '../../components/Sheet'
import { GameSummary, SummaryParts, type SummaryPart } from '../../components/GameSummary'
import { DetailLines } from '../../components/DetailLines'
import { BigButton } from '../../components/BigButton'
import { enqueuePushRound } from '../../remote/outbox'
import { LOCAL_USER } from '../../db/ids'
import { RulesSheet } from '../games/RulesSheet'
import { useRound } from './useRound'
import { holeLoop, ordinal } from './holeLoop'
import { MAX_PUTTS, ScoreRow } from './ScoreRow'

/**
 * Used only when no single game owns the affordance — several games offering
 * at once, or (a bug catalog.test.ts fails on) one that declares nothing.
 * Deliberately says nothing about any game's rules.
 */
const DEFAULT_ACTION_COPY: GameActionCopy = {
  verb: 'Actions',
  plural: 'Actions',
  blurb: 'Optional moves your games are offering right now. Each one says what it costs.',
  emptyState: 'Nothing on offer right now.',
}

export function ScoringScreen() {
  const { roundId } = useParams<{ roundId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const view = useRound(roundId)
  const [hole, setHole] = useState<number>()
  const [standingsOpen, setStandingsOpen] = useState(false)
  const [rulesFor, setRulesFor] = useState<string>()
  const [actionsOpen, setActionsOpen] = useState(false)
  // event ids already sent for retraction — see `giveBack`
  const undoneRef = useRef<Set<string>>(new Set())
  // event key → the id it was written as, or undefined while still in flight.
  // See `emitOnce`.
  const takingRef = useRef<Map<string, string | undefined>>(new Map())
  // What was last SENT per (player, hole), so a burst of taps steps from intent
  // rather than from a stale render — see `setPutts`. `value: null` is a CLEAR
  // that has been sent: a plain number map could not say that, so after a clear
  // the next tap fell back to the derived count and stepped from a number the
  // user had already stepped away from (−, −, + from 1 ended with the log
  // saying 2). Carries its own playerId/hole so the release never parses a key.
  const sentPuttsRef = useRef<
    Map<string, { value: number | null; id: string | undefined }>
  >(new Map())
  // Release a key only once the derivation actually CONTAINS its event — the
  // control on screen now reflects the tap, so a further tap is a further
  // intent rather than a stale duplicate. An effect rather than a render-phase
  // check both because refs must not be touched during render and because
  // after the commit is the honest moment.
  useEffect(() => {
    if (!view) return
    for (const [key, id] of takingRef.current) {
      if (id !== undefined && view.events.some((e) => e.id === id)) takingRef.current.delete(key)
    }
    // PER KEY, and against the EVENT rather than the value it carried.
    // Clearing wholesale dropped entries whose write had not landed, so an
    // emission arriving mid-burst reset the stepper to the stale count and the
    // next tap re-sent a number already sent. Matching on the VALUE instead
    // fixed that but left a narrower version: tapping back to the count already
    // landed (+ then −) makes derived and sent agree while both writes are
    // still in flight, so the key releases early and the next tap re-sends. The
    // value is never wrong — if the two agree, stepping from either gives the
    // same answer — but the duplicate outlives the round in every export.
    // Waiting for the id removes that coincidence; the entry is owned by
    // IDENTITY rather than by its value, which removes the mirror of it that
    // lived in the stamping itself (see `sendPutts`).
    for (const [key, sent] of sentPuttsRef.current) {
      if (sent.id !== undefined && view.events.some((e) => e.id === sent.id)) {
        sentPuttsRef.current.delete(key)
      }
    }
  }, [view])

  // Initial hole, captured ONCE when the view first loads: ?hole= deep link
  // (scorecard tap), else first not-fully-scored hole, else the last hole.
  // Deliberately no auto-advance — completing a hole while the scorekeeper is
  // still tapping ± must never redirect their next tap to a different hole.
  // (Render-phase state adjustment per react.dev "storing info from previous renders".)
  const [derivedHole, setDerivedHole] = useState<number>()
  if (view && derivedHole === undefined) {
    const requested = Number(searchParams.get('hole'))
    if (requested && view.ctx.holesPlayed.includes(requested)) {
      setDerivedHole(requested)
    } else {
      const firstOpen = view.ctx.holesPlayed.find((h) =>
        view.round.players.some((p) => view.ctx.gross.get(p.playerId)?.get(h) === undefined),
      )
      setDerivedHole(firstOpen ?? view.ctx.holesPlayed[view.ctx.holesPlayed.length - 1])
    }
  }

  const pendingInputs = useMemo(() => {
    if (!view) return []
    const inputs: InputRequest[] = []
    for (const d of view.derivations.values()) inputs.push(...d.requiredInputs())
    return inputs
  }, [view])

  // Optional actions (Nassau presses). Surfaced only while the scorekeeper is
  // ON the hole the action starts from — see `onFrontier` below.
  const actions = useMemo(() => {
    if (!view) return []
    const out: GameAction[] = []
    for (const d of view.derivations.values()) out.push(...(d.availableActions?.() ?? []))
    return out
  }, [view])
  const offersActions = useMemo(
    () => (view ? [...view.derivations.values()].some((d) => d.availableActions) : false),
    [view],
  )
  // The vocabulary belongs to the games actually OFFERING (MAI-47): if they all
  // speak the same one, the affordance speaks it too; otherwise it says nothing
  // specific, because "⚡ Press" over a list holding a hammer throw is worse
  // than neutral wording.
  //
  // The test is over every offering game, not over the copies that survive a
  // filter, and both halves of that matter. Counting only DECLARED copies made
  // two Nassaus — a supported round since MAI-44, since `duplicateInstanceProblems`
  // blocks only identical settings — read as "two voices" and fall back to
  // "Actions", losing the empty state that answers "why can't I press?". And
  // it made Nassau beside a game that declares NOTHING read as one voice, so
  // Nassau's verb and blurb rendered over the other game's actions — precisely
  // the failure MAI-47 exists to prevent. Reference equality is the right test:
  // `meta.actions` is one object per engine, so two instances of a game share it.
  const actionCopy = useMemo(() => {
    if (!view) return DEFAULT_ACTION_COPY
    const voices = view.round.games
      .filter((g) => view.derivations.get(g.gameId)?.availableActions)
      .map((g) => getEngine(g.type)?.meta.actions)
    const first = voices[0]
    return first && voices.every((c) => c === first) ? first : DEFAULT_ACTION_COPY
  }, [view])
  const recommendsAction = actions.some((a) => a.recommended)
  // the badge counts what's still on OFFER — a press already running is in the
  // list so it can be undone, but it isn't something left to take
  const openActions = actions.filter((a) => !a.taken).length

  if (view === undefined) return null
  if (view === null) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3">
        <p className="text-stone-400">Round not found.</p>
        <Link className="text-felt-400" to="/">
          ← Home
        </Link>
      </main>
    )
  }

  const { round, ctx, derivations } = view
  const currentHole = hole ?? derivedHole ?? ctx.holesPlayed[0]!
  const loop = holeLoop(round.courseSnapshot, currentHole)
  const holeIdx = ctx.holesPlayed.indexOf(currentHole)
  // Stroke dots belong to whichever game actually allocates them, and that is
  // one shared rule now (src/lib/gameRoles.ts) rather than three surfaces each
  // guessing — a cheap net side bet used to capture this display just by being
  // net, because the old rule took the first net game of any role.
  const dotsGame = strokeGame(round)

  // A round with a main game and several side bets used to put one row per game
  // in a fixed bottom strip. Main games keep their rows; the side bets collapse
  // into a single aggregate that expands in the standings sheet (MAI-50).
  // Roles come from the WHOLE round — an inert game is still a game the group
  // agreed to play, and its category still decides whether an "either" game is
  // the side bet. The COUNTS, though, are of what actually renders: a game
  // whose engine isn't registered, or whose config its engine rejects, gets no
  // derivation and no row (deriveRound), and counting it would collapse a lone
  // survivor under a "Side bets" heading — or, if the inert one is the main
  // game, leave the bar showing side bets and nothing else.
  const { main, side } = partitionByRole(round.games)
  const shown = (games: readonly GameConfig[]) => games.filter((g) => derivations.has(g.gameId))
  const mainGames = shown(main)
  const sideGames = shown(side)
  const collapseSide = shouldGroupSideBets({ main: mainGames.length, side: sideGames.length })
  const barGames = collapseSide ? mainGames : shown(round.games)
  const sideBetParts = collapseSide
    ? sideBetSummary(
        round.players,
        sideGames.flatMap((g) => derivations.get(g.gameId) ?? []),
      )
    : []
  const holeInputs = pendingInputs.filter((i) => i.hole === currentHole)

  // Deliberately NOT a useMemo: `currentHole` is derived below the early
  // returns, so keying a hook on it would mean moving one or the other. It is a
  // handful of array pushes, and `awards(hole)` builds one hole's worth by
  // design (see GameDerivation.awards).
  //
  // COMPLETED IS THE ONE GATE. Awards are editable on any hole the round has
  // reached, right up to `round/completed` — not frontier-gated like the press
  // button above, and not withdrawn once every hole is scored. Read off the
  // EVENTS rather than `round.status`, so a reopened round gets its grid back.
  const roundOver = isCompleted(round, effectiveEvents(view.events))
  const holeAwards: Award[] = []
  if (!roundOver) {
    for (const d of derivations.values()) holeAwards.push(...(d.awards?.(currentHole) ?? []))
  }

  // A press starts from the first unfinished hole — the tee the group is
  // standing on. Only offer it while that hole is the one on screen: entering
  // hole 1's scores must not light up an offer for hole 2 while hole 1 is still
  // showing. The group hasn't walked anywhere yet, and the score can still be
  // corrected; advancing to the next hole is what puts them on that tee.
  const onFrontier = currentHole === ctx.holesPlayed.find((h) => !ctx.finalized(h))

  const allScored = round.players.every((p) =>
    ctx.holesPlayed.every((h) => ctx.gross.get(p.playerId)?.get(h) !== undefined),
  )
  const anyScored = round.players.some((p) =>
    ctx.holesPlayed.some((h) => ctx.gross.get(p.playerId)?.get(h) !== undefined),
  )

  const setScore = (playerId: string, gross: number) => {
    void eventStore.append(round.id, [{ type: 'score/set', playerId, hole: currentHole, gross }])
  }

  // STEPS FROM WHAT WAS SENT, not from what is rendered — resolved inside the
  // handler, because a ref must not be read during render.
  //
  // The control shows the DERIVED count, which lags a tap by a write, a live
  // query and a re-derive. Stepping from it made three quick taps for a
  // three-putt append "1, 1, 1": the hole settled on 1 — the number a putting
  // game would pay on — and the log kept two duplicates. Tapping fast is how a
  // three-putt gets entered, so that is the ordinary case.
  //
  // `null` is NOT RECORDED throughout, whether that came from the derivation or
  // from a clear this screen has already sent but not yet seen land.
  const puttKey = (playerId: string, hole: number) => `${playerId}:${hole}`

  const sentPutts = (playerId: string): number | null => {
    const sent = sentPuttsRef.current.get(puttKey(playerId, currentHole))
    return sent ? sent.value : (ctx.puttsFor(playerId, currentHole) ?? null)
  }

  const sendPutts = (playerId: string, value: number | null, draft: EventDraft) => {
    const key = puttKey(playerId, currentHole)
    // OWNERSHIP IS IDENTITY, not the value. A burst that revisits a count —
    // "+ − +" — leaves the map holding an entry whose value equals an earlier
    // tap's, so a value comparison lets the FIRST append stamp its id onto the
    // LAST tap's entry. The key then releases while that tap is still in
    // flight, the stepper falls back to a derived count mid-burst, and the next
    // tap re-sends a number already sent or clears a count the user meant to
    // keep. Comparing the object itself has no such coincidence in it.
    const entry: { value: number | null; id: string | undefined } = { value, id: undefined }
    const owns = () => sentPuttsRef.current.get(key) === entry
    sentPuttsRef.current.set(key, entry)
    void eventStore
      .append(round.id, [draft])
      .then(([event]) => {
        if (owns()) entry.id = event?.id
      })
      // Nothing was written, so nothing is coming to release this — but only
      // this entry. Deleting whatever sits at the key would drop a later tap's
      // pending value on the floor because an earlier append failed.
      .catch(() => {
        if (owns()) sentPuttsRef.current.delete(key)
      })
  }

  const setPutts = (playerId: string, step: 'more' | 'fewer') => {
    const current = sentPutts(playerId)

    if (step === 'fewer') {
      // already at nothing — the button is disabled, but the derived count it
      // is disabled from lags a clear this screen has just sent
      if (current === null) return
      // Down off zero is the way back to NOT RECORDED. Without it the only
      // erase gesture left is entering 0, which does not mean "I mis-tapped" —
      // it means chip-in, and a junk game pays for one.
      if (current === 0) {
        sendPutts(playerId, null, { type: 'score/puttsClear', playerId, hole: currentHole })
        return
      }
      sendPutts(playerId, current - 1, {
        type: 'score/putts',
        playerId,
        hole: currentHole,
        putts: current - 1,
      })
      return
    }

    // From not-recorded the first tap means ONE, not zero: nearly every hole is
    // a one- or two-putt, and zero is a chip-in — rare, and reachable with a
    // step up then down rather than being what a single tap lands on.
    const next = current === null ? 1 : Math.min(MAX_PUTTS, current + 1)
    // already at the ceiling: no event, so the log gains nothing to say
    if (next === current) return
    sendPutts(playerId, next, {
      type: 'score/putts',
      playerId,
      hole: currentHole,
      putts: next,
    })
  }

  const undo = () => {
    const effective = effectiveEvents(view.events)
    const last = effective[effective.length - 1]
    if (!last || undoneRef.current.has(last.id)) return
    undoneRef.current.add(last.id)
    void eventStore
      .append(round.id, [{ type: 'meta/retract', targetEventId: last.id }])
      .catch(() => undoneRef.current.delete(last.id))
  }

  /**
   * ONE TAP, ONE EVENT — for every control that emits a game event and then
   * SURVIVES ITS OWN TAP, which is all of them except the actions row (whose
   * sheet closes underneath it). An award cell, an input chip: both stay
   * mounted until a re-derive replaces them, so two taps inside one frame both
   * fire against stale props and append the same event twice. Replay shrugs —
   * every reducer here is last-write-wins — but the log is append-only and
   * syncs, so the duplicate outlives the round in every export and archive, and
   * the first game to COUNT its events rather than treat them as a set would
   * double-pay on a fumbled tap.
   *
   * THE KEY IS THE EVENT — the whole payload, not the control that emitted it.
   * Three review rounds narrowed it to that, each time by finding one more
   * thing the identity had to include:
   *
   * - The GAME. `GameEventOffer.id` and `InputRequest.id` are unique only
   *   WITHIN a game (an engine cannot see its siblings) and a round can hold
   *   two instances of one game (MAI-44), so two CTPs both mint `ctp-4-p-ann`.
   * - For an input, the ANSWER. One `InputRequest` renders a row of options and
   *   they are alternatives, not repeats: a slip-tap on a Wolf partner followed
   *   at once by the intended Lone Wolf must keep LONE. Deduping is for the
   *   same answer twice; changing your mind gets through, and replay's
   *   last-write-wins is what makes that correct.
   * - And the option's own `data`, which is exactly what a future game will use
   *   to tell two options apart (BBB's three points, a hammer's multiplier) —
   *   two options sharing a `value` and differing only there are different
   *   answers.
   *
   * Keying on the payload makes all three true by construction rather than by
   * three remembered rules, and there is nothing left for a fourth to miss:
   * identical payload = the same event = a duplicate.
   *
   * RELEASED WHEN THE EVENT IS ACTUALLY VISIBLE IN A DERIVATION, which is what
   * the guard is about and is NOT the same as the append resolving. With two
   * appends in flight the live query re-read triggered by the first can be
   * delivered after the second has committed, so releasing on "committed plus
   * any new derivation" drops a key whose event that derivation does not
   * contain — reopening the window. Holding the event's own id and looking for
   * it closes that. A failed append releases at once, since no derivation is
   * coming to do it.
   */
  type GameEventDraft = Extract<EventDraft, { type: 'game/event' }>
  const emitOnce = (draft: GameEventDraft) => {
    const key = `${draft.gameId}:${draft.kind}:${JSON.stringify(draft.data)}`
    if (takingRef.current.has(key)) return
    takingRef.current.set(key, undefined)
    void eventStore
      .append(round.id, [draft])
      .then(([event]) => {
        // nothing written means nothing to wait for
        if (event) takingRef.current.set(key, event.id)
        else takingRef.current.delete(key)
      })
      .catch(() => takingRef.current.delete(key))
  }

  // An option's own `data` rides UNDER `{ hole, choice }`, never over it: those
  // two are the channel's contract, and an option disagreeing with the prompt
  // it was rendered beneath is a bug rather than a feature (MAI-46).
  const answerInput = (input: InputRequest, option: InputRequest['options'][number]) => {
    emitOnce({
      type: 'game/event',
      gameId: input.gameId,
      kind: input.eventKind,
      data: { ...option.data, hole: input.hole, choice: option.value },
    })
  }

  // The write half both optional channels share (GameEventOffer): take it and
  // one game event lands; give it back and its events are retracted. An award
  // cell and a press row differ in WHEN they may be tapped, never in what a tap
  // does — so they must not differ in the code that does it either.
  const take = (offer: GameEventOffer) => {
    emitOnce({
      type: 'game/event',
      gameId: offer.gameId,
      kind: offer.eventKind,
      data: offer.data,
    })
  }

  // Undo is a compensation event, never a delete (invariant #2). The actions
  // sheet stays open: toggling a bet off then on again shouldn't cost two taps
  // to re-open the same list.
  //
  // Which means, unlike a taken action, these controls survive their own tap —
  // so two quick taps would both fire before the re-derive, appending the same
  // retract twice. Replay tolerates that (targets collect into a Set), but the
  // log is append-only and syncs: the duplicate would outlive the round in
  // every export and archive. Guard on what's already been sent, not on render
  // state. The award grid needs this for exactly the same reason — its cells
  // stay mounted through their own tap.
  // A failed append releases, same as `undo` and `emitOnce`: nothing was
  // written, so the bet is still running and has to stay takeable back.
  const giveBack = (offer: GameEventOffer) => {
    const targets = (offer.undoEventIds ?? []).filter((id) => !undoneRef.current.has(id))
    if (targets.length === 0) return
    targets.forEach((id) => undoneRef.current.add(id))
    void eventStore
      .append(
        round.id,
        targets.map((targetEventId) => ({ type: 'meta/retract' as const, targetEventId })),
      )
      .catch(() => targets.forEach((id) => undoneRef.current.delete(id)))
  }

  const takeAction = (action: GameAction) => {
    setActionsOpen(false)
    take(action)
  }

  const finish = async () => {
    await eventStore.append(round.id, [{ type: 'round/completed' }])
    await roundRepo.put({ ...round, status: 'completed' })
    // Push only owner-scoped (signed-in) rounds; guest rounds stay local until
    // claimed on sign-in. Re-read so the pushed snapshot matches what's stored
    // (put re-stamps updatedAt). The round carries its own owner.
    const stored = await roundRepo.get(round.id)
    const owner = stored?.userId ?? LOCAL_USER
    if (stored && owner !== LOCAL_USER) void enqueuePushRound(owner, stored)
    navigate(`/round/${round.id}/settle`)
  }

  return (
    <main className="flex min-h-dvh select-none flex-col pb-40">
      <header className="flex items-center justify-between py-4">
        <div className="flex items-center gap-3">
          <Link to="/" className="px-1 text-stone-400" aria-label="home">
            ⌂
          </Link>
          <Link
            to={`/round/${round.id}/start`}
            className="px-1 text-stone-400"
            aria-label="round info"
          >
            ⓘ
          </Link>
        </div>
        <Link to={`/round/${round.id}/card`} className="text-sm font-medium text-stone-400">
          Scorecard
        </Link>
        <button onClick={undo} className="px-1 text-stone-400" aria-label="undo">
          ↩ Undo
        </button>
      </header>

      <section className="flex items-center justify-between py-2">
        <HoleArrow
          dir="prev"
          disabled={holeIdx <= 0}
          onClick={() => setHole(ctx.holesPlayed[holeIdx - 1]!)}
        />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={currentHole}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.08 }}
            className="text-center"
          >
            <p className="font-display text-[10px] uppercase text-felt-300">Hole</p>
            <p className="font-display animate-stamp text-5xl text-white [text-shadow:4px_4px_0_rgb(0_0_0/0.6)]">
              {currentHole}
            </p>
            {/* Two loops of a nine: say which tee they're actually standing on.
                The first time round needs no explaining — the card number and
                the hole are the same. */}
            {loop && loop.nth > 1 && (
              <p className="font-display mt-1 text-[10px] uppercase text-coin-400">
                {ordinal(loop.nth)} time round · hole {loop.hole}
              </p>
            )}
            <p className="mt-2 text-lg text-stone-400">
              par {ctx.par(currentHole)} · si {ctx.strokeIndex(currentHole)}
            </p>
          </motion.div>
        </AnimatePresence>
        <HoleArrow
          dir="next"
          disabled={holeIdx >= ctx.holesPlayed.length - 1}
          onClick={() => setHole(ctx.holesPlayed[holeIdx + 1]!)}
        />
      </section>

      {holeInputs.length > 0 && (
        <section className="mb-2 space-y-2.5">
          {holeInputs.map((input) => (
            <div key={input.id} className="pixel border-coin-500 bg-coin-500/10 p-3">
              <p className="mb-2 text-lg text-coin-400">
                <span className="animate-blink">▶ </span>
                {input.prompt}
              </p>
              <div className="flex flex-wrap gap-2.5">
                {input.options.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => answerInput(input, o)}
                    className="pixel-press border-stone-600 bg-stone-800 px-4 py-2.5 text-lg"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Availability, parked behind a button so it never interrupts; the gold
          treatment is the only push, and only when convention says act (2 down).
          Always tappable, including with nothing on offer — "why can't I press?"
          deserves the sheet's answer, not a dead control. */}
      {offersActions && onFrontier && !allScored && (
        <section className="mb-2 flex justify-end">
          <button
            onClick={() => setActionsOpen(true)}
            aria-label={`${actionCopy.verb.toLowerCase()} options — ${openActions} available`}
            className={`pixel-press font-display px-4 py-2 text-[10px] uppercase ${
              recommendsAction
                ? 'border-coin-500 bg-coin-500/15 text-coin-400'
                : openActions === 0
                  ? 'border-stone-700 bg-stone-900 text-stone-500'
                  : 'border-stone-600 bg-stone-800 text-stone-300'
            }`}
          >
            {/* only the marker blinks — house convention (HomeScreen, UpdateToast).
                A primary control that strobes for ten holes is worse than the
                interrupting card this replaced. */}
            {recommendsAction && <span className="animate-blink mr-1">▶</span>}⚡ {actionCopy.verb}
            {openActions > 0 && <span className="ml-1.5">· {openActions}</span>}
          </button>
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        {round.players.map((p) => (
          <ScoreRow
            key={p.playerId}
            name={p.name}
            par={ctx.par(currentHole)}
            gross={ctx.gross.get(p.playerId)?.get(currentHole)}
            strokes={dotsGame ? ctx.strokesFor(dotsGame.gameId, p.playerId, currentHole) : 0}
            onScore={(gross) => setScore(p.playerId, gross)}
            putts={ctx.puttsFor(p.playerId, currentHole)}
            onPutts={round.trackPutts ? (step) => setPutts(p.playerId, step) : undefined}
          />
        ))}
      </section>

      <AwardGrid
        awards={holeAwards}
        playerIds={round.players.map((p) => p.playerId)}
        gameName={(gameId) => {
          const g = round.games.find((game) => game.gameId === gameId)
          return g ? gameLabel(g, round.games) : ''
        }}
        onTake={take}
        onUndo={giveBack}
      />

      <div className="fixed inset-x-0 bottom-0 z-30 border-t-4 border-felt-600 bg-stone-950/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="mx-auto max-w-md">
          {allScored ? (
            <BigButton className="mb-1 w-full" onClick={() => void finish()}>
              🏁 Finish round
            </BigButton>
          ) : (
            <button className="w-full text-left" onClick={() => setStandingsOpen(true)}>
              {barGames.map((g) => {
                const d = derivations.get(g.gameId)
                if (!d) return null
                return (
                  <div key={g.gameId} className="flex items-baseline justify-between gap-3 py-0.5">
                    <span className="font-display text-[10px] uppercase text-felt-300">
                      {gameLabel(g, round.games)}
                    </span>
                    <GameSummary derivation={d} />
                  </div>
                )
              })}
              {collapseSide && (
                <div className="flex items-baseline justify-between gap-3 py-0.5">
                  <span className="font-display text-[10px] uppercase text-felt-300">
                    Side bets
                  </span>
                  <span className="inline-flex items-baseline gap-2">
                    <SummaryParts parts={sideBetParts} />
                    <span className="font-display text-[10px] text-felt-400">▶</span>
                  </span>
                </div>
              )}
            </button>
          )}
        </div>
      </div>

      <Sheet open={standingsOpen} onClose={() => setStandingsOpen(false)}>
        <div className="space-y-5">
          <Link
            to={`/round/${round.id}/card`}
            className="pixel-press font-display block border-felt-600 bg-felt-900/60 px-4 py-3 text-center text-[10px] uppercase"
          >
            View full card ▶
          </Link>
          {/* When the bar collapses the side bets, this is where they expand —
              so the sheet groups them under a heading rather than leaving the
              bar's "▶" pointing at an undifferentiated list. Ungrouped, the
              order is round.games as before. */}
          {/* Both halves hold only games that HAVE a derivation, so the index
              below is always the first side bet actually drawn — the heading
              can't be attached to a row that returns null. */}
          {(collapseSide ? [...mainGames, ...sideGames] : shown(round.games)).map((g, i) => {
            const d = derivations.get(g.gameId)
            if (!d) return null
            const label = gameLabel(g, round.games)
            return (
              <div key={g.gameId}>
                {collapseSide && i === mainGames.length && (
                  <h2 className="font-display mb-2.5 border-t border-stone-800 pt-4 text-[10px] uppercase text-stone-400">
                    Side bets
                  </h2>
                )}
                <div className="mb-2.5 flex items-baseline justify-between">
                  <h3 className="font-display flex items-baseline gap-2 text-xs uppercase text-felt-300">
                    {label}
                    {g.handicap?.mode === 'net' && g.handicap.allowancePct !== 100 && (
                      <span className="text-[10px] text-stone-400">{g.handicap.allowancePct}%</span>
                    )}
                  </h3>
                  <button
                    aria-label={`${label} rules`}
                    className="font-display text-[10px] uppercase text-felt-400"
                    onClick={() => setRulesFor(g.type)}
                  >
                    Rules ?
                  </button>
                </div>
                {d.detailLines && d.detailLines.length > 0 && (
                  <div className="mb-3 border-l-2 border-stone-800 pl-3">
                    <DetailLines lines={d.detailLines} />
                  </div>
                )}
                {/* Name and money share the top line; the per-bet status gets
                    its own beneath. Squeezing all three into one row wrapped a
                    long name onto two lines and — worse — broke "-$5" between
                    the minus and the digits, so a player read as owing "$5"
                    with a stray dash above it. A currency amount never wraps:
                    it is shrink-0 and nowrap, and the status line is what
                    yields. Nassau's detail grew to three bets' worth of state
                    ("F9 ✓3&2 · B9 AS · 18 ↑3"), which is what tipped it over. */}
                <ul className="space-y-2">
                  {d.standings.map((line) => (
                    <motion.li
                      layout
                      key={line.id}
                      className="pixel border-stone-700 bg-stone-800/70 px-3.5 py-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate text-lg font-medium">{line.label}</span>
                        <span
                          className={`font-display shrink-0 whitespace-nowrap text-xs ${
                            line.amountCents > 0
                              ? 'text-felt-300'
                              : line.amountCents < 0
                                ? 'text-flag-500'
                                : 'text-stone-400'
                          }`}
                        >
                          {formatCentsSigned(line.amountCents)}
                        </span>
                      </div>
                      {line.detail && (
                        <p className="mt-1 text-stone-400">{line.detail}</p>
                      )}
                    </motion.li>
                  ))}
                </ul>
                {d.holeSummary(currentHole).map((s) => (
                  <p key={s} className="mt-2 text-lg text-stone-400">
                    {s}
                  </p>
                ))}
                {/* A pot can die before anyone taps Finish — every hole scored
                    and the last one tied is enough (ctx.finalized). This is the
                    screen the group is looking at while deciding what's still
                    live, so the money surface says it here too, not only on
                    settle. Same tier as there: below the money, behind a rule. */}
                {d.notes && d.notes.length > 0 && (
                  <div className="mt-2.5 border-t border-stone-800 pt-2.5">
                    {d.notes.map((note) => (
                      <p key={note} className="text-stone-500">
                        {note}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {!allScored && anyScored && (
            <BigButton
              variant="outline"
              className="w-full text-[10px] normal-case text-stone-300"
              onClick={() => void finish()}
            >
              🏁 Finish round early — settle what's been played
            </BigButton>
          )}
        </div>
      </Sheet>

      <ActionsSheet
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
        actions={actions}
        copy={actionCopy}
        games={round.games.flatMap((g) => {
          const d = derivations.get(g.gameId)
          return d ? [{ gameId: g.gameId, name: gameLabel(g, round.games), derivation: d }] : []
        })}
        onTake={takeAction}
        onUndo={giveBack}
      />

      <RulesSheet type={rulesFor} onClose={() => setRulesFor(undefined)} />
    </main>
  )
}

/**
 * The collapsed side-bets line: who is up and who is down across every side
 * bet at once.
 *
 * This is a RUNNING AGGREGATE, which is the documented exception rather than
 * the rule — a game's own bar row recaps the latest decided hole (see
 * core/summary.ts). Nothing else compresses N games into one line, and the
 * per-hole detail is one tap away in the standings sheet.
 *
 * Extremes only: the biggest winner and the biggest loser. Ties keep
 * `round.players` order, so the row cannot reshuffle between re-derives while
 * two players sit level.
 */
function sideBetSummary(
  players: readonly Round['players'][number][],
  derivations: readonly GameDerivation[],
): SummaryPart[] {
  const combined = combineSettlements(
    players.map((p) => p.playerId),
    derivations.map((d) => d.settlement),
  )
  const moved = players
    .map((p) => ({ name: p.name, cents: combined[p.playerId] ?? 0 }))
    .filter((p) => p.cents !== 0)
  // Same wording the per-game convention uses before a hole is decided, rather
  // than a row of "+$0"s that looks like a result.
  if (moved.length === 0) return [{ label: '', value: 'no money yet' }]
  const top = moved.reduce((a, b) => (b.cents > a.cents ? b : a))
  const bottom = moved.reduce((a, b) => (b.cents < a.cents ? b : a))
  const parts = [{ label: '', value: `${top.name} ${formatCentsSigned(top.cents)}` }]
  // Zero-sum means a non-empty list always has both ends, but never assume it.
  if (bottom !== top) parts.push({ label: '', value: `${bottom.name} ${formatCentsSigned(bottom.cents)}` })
  return parts
}

function HoleArrow({
  dir,
  disabled,
  onClick,
}: {
  dir: 'prev' | 'next'
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      aria-label={dir === 'prev' ? 'previous hole' : 'next hole'}
      disabled={disabled}
      onClick={onClick}
      className="pixel-press font-display flex size-14 items-center justify-center border-stone-700 bg-stone-900 text-sm text-felt-300 disabled:opacity-25"
    >
      {dir === 'prev' ? '◀' : '▶'}
    </button>
  )
}
