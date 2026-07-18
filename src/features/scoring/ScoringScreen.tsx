import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { motion, AnimatePresence } from 'motion/react'
import { eventStore } from '../../db/eventStore'
import { roundRepo } from '../../db/repos'
import { effectiveEvents } from '../../engine/core/replay'
import { formatCentsSigned } from '../../engine/core/money'
import type { InputRequest } from '../../engine/catalog'
import { Sheet } from '../../components/Sheet'
import { useRound } from './useRound'
import { ScoreRow } from './ScoreRow'

export function ScoringScreen() {
  const { roundId } = useParams<{ roundId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const view = useRound(roundId)
  const [hole, setHole] = useState<number>()
  const [standingsOpen, setStandingsOpen] = useState(false)

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
  const holeIdx = ctx.holesPlayed.indexOf(currentHole)
  const primaryGame = round.games[0]
  const holeInputs = pendingInputs.filter((i) => i.hole === currentHole)

  const allScored = round.players.every((p) =>
    ctx.holesPlayed.every((h) => ctx.gross.get(p.playerId)?.get(h) !== undefined),
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

  const finish = async () => {
    await eventStore.append(round.id, [{ type: 'round/completed' }])
    await roundRepo.put({ ...round, status: 'completed' })
    navigate(`/round/${round.id}/settle`)
  }

  return (
    <main className="flex min-h-dvh select-none flex-col pb-40">
      <header className="flex items-center justify-between py-4">
        <Link to="/" className="px-1 text-stone-400" aria-label="home">
          ⌂
        </Link>
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
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="text-center"
          >
            <p className="text-sm font-medium uppercase tracking-widest text-felt-300">Hole</p>
            <p className="text-6xl font-extrabold tabular-nums">{currentHole}</p>
            <p className="mt-1 text-sm text-stone-400">
              Par {ctx.par(currentHole)} · SI {ctx.strokeIndex(currentHole)}
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
        <section className="mb-2 space-y-2">
          {holeInputs.map((input) => (
            <div key={input.id} className="rounded-2xl bg-amber-500/10 p-3 ring-1 ring-amber-500/40">
              <p className="mb-2 text-sm font-semibold text-amber-400">{input.prompt}</p>
              <div className="flex flex-wrap gap-2">
                {input.options.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => answerInput(input, o.value)}
                    className="rounded-xl bg-stone-800 px-4 py-2.5 text-sm font-semibold ring-1 ring-stone-600 active:bg-stone-700"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
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

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-800 bg-stone-950/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="mx-auto max-w-md">
          {allScored ? (
            <button
              onClick={() => void finish()}
              className="mb-1 w-full rounded-2xl bg-felt-600 py-3.5 text-lg font-bold active:bg-felt-500"
            >
              Finish round 🏁
            </button>
          ) : (
            <button className="w-full text-left" onClick={() => setStandingsOpen(true)}>
              {round.games.map((g) => {
                const d = derivations.get(g.gameId)
                if (!d) return null
                return (
                  <div key={g.gameId} className="flex items-baseline justify-between py-0.5">
                    <span className="text-sm font-semibold text-felt-300">
                      {gameName(g.type)}
                    </span>
                    <span className="text-sm text-stone-300">{d.summary}</span>
                  </div>
                )
              })}
            </button>
          )}
        </div>
      </div>

      <Sheet open={standingsOpen} onClose={() => setStandingsOpen(false)}>
        <div className="space-y-5">
          {round.games.map((g) => {
            const d = derivations.get(g.gameId)
            if (!d) return null
            return (
              <div key={g.gameId}>
                <h3 className="mb-2 text-lg font-bold">{gameName(g.type)}</h3>
                <ul className="space-y-1.5">
                  {d.standings.map((line) => (
                    <motion.li
                      layout
                      key={line.id}
                      className="flex items-center justify-between rounded-xl bg-stone-800/60 px-3.5 py-2.5"
                    >
                      <span className="font-medium">{line.label}</span>
                      <span className="flex items-baseline gap-2.5">
                        {line.detail && <span className="text-xs text-stone-400">{line.detail}</span>}
                        <span
                          className={`font-bold tabular-nums ${
                            line.amountCents > 0
                              ? 'text-felt-400'
                              : line.amountCents < 0
                                ? 'text-flag-500'
                                : 'text-stone-400'
                          }`}
                        >
                          {formatCentsSigned(line.amountCents)}
                        </span>
                      </span>
                    </motion.li>
                  ))}
                </ul>
                {d.holeSummary(currentHole).map((s) => (
                  <p key={s} className="mt-1.5 text-sm text-stone-400">
                    {s}
                  </p>
                ))}
              </div>
            )
          })}
        </div>
      </Sheet>
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
      className="flex size-14 items-center justify-center rounded-2xl bg-stone-900 text-2xl text-stone-300 ring-1 ring-stone-800 active:bg-stone-800 disabled:opacity-25"
    >
      {dir === 'prev' ? '‹' : '›'}
    </button>
  )
}

function gameName(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1)
}
