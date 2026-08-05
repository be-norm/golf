import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { motion, AnimatePresence } from 'motion/react'
import { eventStore } from '../../db/eventStore'
import { roundRepo } from '../../db/repos'
import { effectiveEvents } from '../../engine/core/replay'
import { formatCentsSigned } from '../../engine/core/money'
import type { GameAction, InputRequest } from '../../engine/catalog'
import { ActionsSheet } from './ActionsSheet'
import { Sheet } from '../../components/Sheet'
import { GameSummary } from '../../components/GameSummary'
import { DetailLines } from '../../components/DetailLines'
import { BigButton } from '../../components/BigButton'
import { enqueuePushRound } from '../../remote/outbox'
import { LOCAL_USER } from '../../db/ids'
import { RulesSheet } from '../games/RulesSheet'
import { useRound } from './useRound'
import { holeLoop, ordinal } from './holeLoop'
import { ScoreRow } from './ScoreRow'

export function ScoringScreen() {
  const { roundId } = useParams<{ roundId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const view = useRound(roundId)
  const [hole, setHole] = useState<number>()
  const [standingsOpen, setStandingsOpen] = useState(false)
  const [rulesFor, setRulesFor] = useState<string>()
  const [actionsOpen, setActionsOpen] = useState(false)
  // event ids already sent for retraction — see `undoAction`
  const undoneRef = useRef<Set<string>>(new Set())

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
  // stroke dots show the first NET game's allocation (games[0] was arbitrary)
  const primaryGame = round.games.find((g) => g.handicap.mode === 'net') ?? round.games[0]
  const holeInputs = pendingInputs.filter((i) => i.hole === currentHole)

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

  const undo = () => {
    const effective = effectiveEvents(view.events)
    const last = effective[effective.length - 1]
    if (last) void eventStore.append(round.id, [{ type: 'meta/retract', targetEventId: last.id }])
  }

  const answerInput = (input: InputRequest, choice: string) => {
    void eventStore.append(round.id, [
      { type: 'game/event', gameId: input.gameId, kind: input.eventKind, data: { hole: input.hole, choice } },
    ])
  }

  const takeAction = (action: GameAction) => {
    setActionsOpen(false)
    void eventStore.append(round.id, [
      { type: 'game/event', gameId: action.gameId, kind: action.eventKind, data: action.data },
    ])
  }

  // Undo is a compensation event, never a delete (invariant #2). The sheet
  // stays open: toggling a bet off then on again shouldn't cost two taps to
  // re-open the same list.
  //
  // Which means, unlike `takeAction`, this button survives its own tap — so two
  // quick taps would both fire before the re-derive, appending the same retract
  // twice. Replay tolerates that (targets collect into a Set), but the log is
  // append-only and syncs: the duplicate would outlive the round in every
  // export and archive. Guard on what's already been sent, not on render state.
  const undoAction = (action: GameAction) => {
    const targets = (action.undoEventIds ?? []).filter((id) => !undoneRef.current.has(id))
    if (targets.length === 0) return
    targets.forEach((id) => undoneRef.current.add(id))
    void eventStore.append(
      round.id,
      targets.map((targetEventId) => ({ type: 'meta/retract' as const, targetEventId })),
    )
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
                    onClick={() => answerInput(input, o.value)}
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
            aria-label={`press options — ${openActions} available`}
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
            {recommendsAction && <span className="animate-blink mr-1">▶</span>}⚡ Press
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
            strokes={primaryGame ? ctx.strokesFor(primaryGame.gameId, p.playerId, currentHole) : 0}
            onScore={(gross) => setScore(p.playerId, gross)}
          />
        ))}
      </section>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t-4 border-felt-600 bg-stone-950/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="mx-auto max-w-md">
          {allScored ? (
            <BigButton className="mb-1 w-full" onClick={() => void finish()}>
              🏁 Finish round
            </BigButton>
          ) : (
            <button className="w-full text-left" onClick={() => setStandingsOpen(true)}>
              {round.games.map((g) => {
                const d = derivations.get(g.gameId)
                if (!d) return null
                return (
                  <div key={g.gameId} className="flex items-baseline justify-between gap-3 py-0.5">
                    <span className="font-display text-[10px] uppercase text-felt-300">
                      {gameName(g.type)}
                    </span>
                    <GameSummary derivation={d} />
                  </div>
                )
              })}
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
          {round.games.map((g) => {
            const d = derivations.get(g.gameId)
            if (!d) return null
            return (
              <div key={g.gameId}>
                <div className="mb-2.5 flex items-baseline justify-between">
                  <h3 className="font-display flex items-baseline gap-2 text-xs uppercase text-felt-300">
                    {gameName(g.type)}
                    {g.handicap.mode === 'net' && g.handicap.allowancePct !== 100 && (
                      <span className="text-[10px] text-stone-400">{g.handicap.allowancePct}%</span>
                    )}
                  </h3>
                  <button
                    aria-label={`${g.type} rules`}
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
        games={round.games.flatMap((g) => {
          const d = derivations.get(g.gameId)
          return d ? [{ gameId: g.gameId, name: gameName(g.type), derivation: d }] : []
        })}
        onTake={takeAction}
        onUndo={undoAction}
      />

      <RulesSheet type={rulesFor} onClose={() => setRulesFor(undefined)} />
    </main>
  )
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

function gameName(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1)
}
