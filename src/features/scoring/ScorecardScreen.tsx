import { Link, useNavigate, useParams } from 'react-router'
import { useRound } from './useRound'

/** Classic scorecard grid. Tap a cell to jump to that hole for correction. */
export function ScorecardScreen() {
  const { roundId } = useParams<{ roundId: string }>()
  const navigate = useNavigate()
  const view = useRound(roundId)

  if (!view) return null
  const { round, ctx } = view

  const half = (holes: number[]) => (
    <div className="overflow-x-auto rounded-2xl bg-stone-900/60 ring-1 ring-stone-800">
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
                <td className="max-w-20 truncate px-2 py-2 text-left font-semibold">{p.name}</td>
                {holes.map((h, i) => {
                  const s = scores[i]
                  const diff = s !== undefined ? s - ctx.par(h) : 0
                  return (
                    <td key={h} className="p-0">
                      <button
                        className={`h-10 w-full min-w-8 font-semibold active:bg-stone-700 ${
                          s === undefined
                            ? 'text-stone-600'
                            : diff < 0
                              ? 'text-felt-400'
                              : diff > 0
                                ? 'text-amber-300'
                                : ''
                        }`}
                        onClick={() => navigate(`/round/${round.id}?hole=${h}`)}
                      >
                        {s ?? '·'}
                      </button>
                    </td>
                  )
                })}
                <td className="px-2 font-bold">{complete || total > 0 ? total : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  const front = ctx.holesPlayed.filter((h) => h <= 9)
  const back = ctx.holesPlayed.filter((h) => h > 9)

  return (
    <main className="flex min-h-dvh flex-col gap-4 py-6">
      <header className="flex items-center justify-between">
        <Link to={`/round/${round.id}`} className="text-stone-400">
          ← Back
        </Link>
        <h1 className="font-bold">{round.courseSnapshot.name}</h1>
        <span className="w-10" />
      </header>
      {front.length > 0 && half(front)}
      {back.length > 0 && half(back)}
      <p className="text-center text-xs text-stone-500">Tap any cell to correct that hole.</p>
    </main>
  )
}
