import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { motion, AnimatePresence } from 'motion/react'
import { eventStore } from '../../db/eventStore'
import { roundRepo } from '../../db/repos'
import { effectiveEvents } from '../../engine/core/replay'
import { formatCentsSigned } from '../../engine/core/money'
import type { InputRequest } from '../../engine/catalog'
import { Sheet } from '../../components/Sheet'
import { enqueueRoundArchive } from '../../remote/outbox'
import { RulesSheet } from '../games/RulesSheet'
import { useRound } from './useRound'
import { ScoreRow } from './ScoreRow'

export function ScoringScreen() {
  const { roundId } = useParams<{ roundId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const view = useRound(roundId)
  const [hole, setHole] = useState<number>()
  const [standingsOpen, setStandingsOpen] = useState(false)
  const [rulesFor, setRulesFor] = useState<string>()

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
    void enqueueRoundArchive({ ...round, status: 'completed' })
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
                <span className="animate-blink">▶</span> {input.prompt}
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
            <button
              onClick={() => void finish()}
              className="pixel-press font-display mb-1 w-full border-felt-300 bg-felt-600 py-4 text-sm uppercase"
            >
              🏁 Finish round
            </button>
          ) : (
            <button className="w-full text-left" onClick={() => setStandingsOpen(true)}>
              {round.games.map((g) => {
                const d = derivations.get(g.gameId)
                if (!d) return null
                return (
                  <div key={g.gameId} className="flex items-baseline justify-between py-0.5">
                    <span className="font-display text-[10px] uppercase text-felt-300">
                      {gameName(g.type)}
                    </span>
                    <span className="text-lg text-stone-300">{d.summary}</span>
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
                  <h3 className="font-display text-xs uppercase text-felt-300">
                    {gameName(g.type)}
                  </h3>
                  <button
                    aria-label={`${g.type} rules`}
                    className="font-display text-[10px] uppercase text-felt-400"
                    onClick={() => setRulesFor(g.type)}
                  >
                    Rules ?
                  </button>
                </div>
                <ul className="space-y-2">
                  {d.standings.map((line) => (
                    <motion.li
                      layout
                      key={line.id}
                      className="pixel flex items-center justify-between border-stone-700 bg-stone-800/70 px-3.5 py-2.5"
                    >
                      <span className="text-lg font-medium">{line.label}</span>
                      <span className="flex items-baseline gap-2.5">
                        {line.detail && <span className="text-stone-400">{line.detail}</span>}
                        <span
                          className={`font-display text-xs ${
                            line.amountCents > 0
                              ? 'text-felt-300'
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
                  <p key={s} className="mt-2 text-lg text-stone-400">
                    {s}
                  </p>
                ))}
              </div>
            )
          })}
        </div>
      </Sheet>

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
