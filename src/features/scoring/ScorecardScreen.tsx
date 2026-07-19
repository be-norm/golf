import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { buildHoleLedger } from '../../engine/ledger'
import { formatCentsSigned } from '../../engine/core/money'
import { useRound } from './useRound'

/**
 * The full picture: classic scorecard grids on top (tap a cell to correct),
 * then a per-game hole ledger showing exactly where the money moved —
 * derived from prefix replays of the event log, so it IS the engine's math.
 */
export function ScorecardScreen() {
  const { roundId } = useParams<{ roundId: string }>()
  const navigate = useNavigate()
  const view = useRound(roundId)
  const [selectedGameId, setSelectedGameId] = useState<string>()

  const ledger = useMemo(
    () =>
      view
        ? buildHoleLedger(view.round, view.events, view.ctx.holesPlayed, view.derivations)
        : undefined,
    [view],
  )

  if (!view) return null
  const { round, ctx, derivations } = view
  const nameOf = new Map(round.players.map((p) => [p.playerId, p.name]))
  const activeGame = round.games.find((g) => g.gameId === selectedGameId) ?? round.games[0]

  const half = (holes: number[]) => (
    <div className="pixel overflow-x-auto border-stone-700 bg-stone-900/70">
      <table className="w-full text-center text-sm tabular-nums">
        <thead>
          <tr className="text-stone-400">
            <th className="px-2 py-2 text-left font-medium">Hole</th>
            {holes.map((h) => (
              <th key={h} className="min-w-8 px-1 py-2 font-semibold">
                {h}
              </th>
            ))}
            <th className="px-2 py-2 font-semibold">—</th>
          </tr>
          <tr className="text-xs text-stone-500">
            <td className="px-2 pb-1 text-left">Par</td>
            {holes.map((h) => (
              <td key={h} className="pb-1">
                {ctx.par(h)}
              </td>
            ))}
            <td className="pb-1">{holes.reduce((a, h) => a + ctx.par(h), 0)}</td>
          </tr>
        </thead>
        <tbody>
          {round.players.map((p) => {
            const scores = holes.map((h) => ctx.gross.get(p.playerId)?.get(h))
            const total = scores.reduce<number>((a, s) => a + (s ?? 0), 0)
            const complete = scores.every((s) => s !== undefined)
            return (
              <tr key={p.playerId} className="border-t border-stone-800">
                <td className="max-w-20 truncate px-2 py-2 text-left text-base font-semibold">
                  {p.name}
                </td>
                {holes.map((h, i) => {
                  const s = scores[i]
                  const diff = s !== undefined ? s - ctx.par(h) : 0
                  const strokes = activeGame
                    ? ctx.strokesFor(activeGame.gameId, p.playerId, h)
                    : 0
                  return (
                    <td key={h} className="p-0">
                      <button
                        className={`h-10 w-full min-w-8 text-base font-semibold active:bg-stone-700 ${
                          strokes > 0 ? 'border-b-2 border-felt-500' : ''
                        } ${
                          s === undefined
                            ? 'text-stone-600'
                            : diff < 0
                              ? 'text-felt-300'
                              : diff > 0
                                ? 'text-coin-400'
                                : ''
                        }`}
                        onClick={() => navigate(`/round/${round.id}?hole=${h}`)}
                      >
                        {s ?? '·'}
                      </button>
                    </td>
                  )
                })}
                <td className="px-2 text-base font-bold">{complete || total > 0 ? total : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  const front = ctx.holesPlayed.filter((h) => h <= 9)
  const back = ctx.holesPlayed.filter((h) => h > 9)
  const activeLedger = activeGame ? (ledger?.get(activeGame.gameId) ?? []) : []
  const activeDerivation = activeGame ? derivations.get(activeGame.gameId) : undefined

  return (
    <main className="flex min-h-dvh flex-col gap-4 py-6">
      <header className="flex items-center justify-between">
        <Link to={`/round/${round.id}`} className="text-stone-400">
          ← Back
        </Link>
        <h1 className="font-display text-xs uppercase text-felt-300">{round.courseSnapshot.name}</h1>
        <span className="w-10" />
      </header>

      {front.length > 0 && half(front)}
      {back.length > 0 && half(back)}
      <p className="text-center text-sm text-stone-500">
        Tap a cell to correct that hole
        {activeGame && activeGame.handicap.mode === 'net'
          ? ' · green underline = stroke hole'
          : ''}
      </p>

      {round.games.length > 0 && (
        <section className="mt-2">
          <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">
            Where the money moved
          </h2>

          {round.games.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {round.games.map((g) => (
                <button
                  key={g.gameId}
                  onClick={() => setSelectedGameId(g.gameId)}
                  className={`font-display px-3 py-2 text-[10px] uppercase ${
                    g.gameId === activeGame?.gameId
                      ? 'pixel border-felt-300 bg-felt-700'
                      : 'border-2 border-stone-700 bg-stone-800 text-stone-400'
                  }`}
                >
                  {g.type}
                </button>
              ))}
            </div>
          )}

          {activeDerivation && (
            <p className="mb-3 text-lg text-stone-300">
              <span className="font-display mr-2 text-[10px] uppercase text-felt-300">
                {activeGame!.type}
              </span>
              {activeDerivation.summary}
            </p>
          )}

          <ul className="space-y-2">
            {activeLedger.map((impact) => (
              <li key={impact.hole} className="pixel border-stone-700 bg-stone-900/70 px-3 py-2.5">
                <div className="flex items-start gap-3">
                  <span className="font-display mt-0.5 min-w-8 text-center text-sm text-felt-300">
                    {impact.hole}
                  </span>
                  <div className="min-w-0 flex-1">
                    {impact.summary.map((s) => (
                      <p key={s} className="text-lg leading-snug text-stone-200">
                        {s}
                      </p>
                    ))}
                    {impact.deltas.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-x-3 text-base">
                        {impact.deltas.map((d) => (
                          <span
                            key={d.playerId}
                            className={d.cents > 0 ? 'text-felt-300' : 'text-flag-500'}
                          >
                            {nameOf.get(d.playerId)} {formatCentsSigned(d.cents)}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
            {activeLedger.length === 0 && (
              <p className="text-lg text-stone-500">Nothing scored yet.</p>
            )}
          </ul>
        </section>
      )}
    </main>
  )
}
