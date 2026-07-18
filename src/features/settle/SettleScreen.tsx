import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { motion } from 'motion/react'
import { formatCents, formatCentsSigned, minimalTransfers } from '../../engine/core/money'
import { eventStore } from '../../db/eventStore'
import { roundRepo } from '../../db/repos'
import { useRound } from '../scoring/useRound'
import { BigButton } from '../../components/BigButton'
import { buildExport, downloadExport } from './exportRound'

export function SettleScreen() {
  const { roundId } = useParams<{ roundId: string }>()
  const navigate = useNavigate()
  const view = useRound(roundId)
  const [expanded, setExpanded] = useState<string>()

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

  const { round, derivations } = view
  const nameOf = new Map(round.players.map((p) => [p.playerId, p.name]))

  const combined: Record<string, number> = Object.fromEntries(
    round.players.map((p) => [p.playerId, 0]),
  )
  for (const d of derivations.values()) {
    for (const [id, cents] of Object.entries(d.settlement.perPlayerCents)) {
      combined[id] = (combined[id] ?? 0) + cents
    }
  }
  const transfers = minimalTransfers(combined)
  const ranked = [...round.players].sort(
    (a, b) => (combined[b.playerId] ?? 0) - (combined[a.playerId] ?? 0),
  )

  const reopen = async () => {
    await eventStore.append(round.id, [{ type: 'round/reopened' }])
    await roundRepo.put({ ...round, status: 'live' })
    navigate(`/round/${round.id}`)
  }

  return (
    <main className="flex min-h-dvh flex-col gap-5 py-6">
      <Confetti />
      <header className="flex items-center justify-between">
        <Link to="/" className="text-stone-400">
          ⌂ Home
        </Link>
        <h1 className="font-bold">{round.courseSnapshot.name}</h1>
        <Link to={`/round/${round.id}/card`} className="text-sm text-stone-400">
          Card
        </Link>
      </header>

      <section className="rounded-3xl bg-felt-900/50 p-5 ring-1 ring-felt-700">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-felt-300">
          Final standings
        </h2>
        <ul className="space-y-2">
          {ranked.map((p, i) => (
            <motion.li
              key={p.playerId}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
              className="flex items-center justify-between"
            >
              <span className="text-lg font-semibold">
                {i === 0 && (combined[p.playerId] ?? 0) > 0 ? '🏆 ' : ''}
                {p.name}
              </span>
              <span
                className={`text-lg font-bold tabular-nums ${
                  (combined[p.playerId] ?? 0) > 0
                    ? 'text-felt-400'
                    : (combined[p.playerId] ?? 0) < 0
                      ? 'text-flag-500'
                      : 'text-stone-400'
                }`}
              >
                {formatCentsSigned(combined[p.playerId] ?? 0)}
              </span>
            </motion.li>
          ))}
        </ul>
      </section>

      {transfers.length > 0 && (
        <section className="rounded-3xl bg-stone-900/60 p-5 ring-1 ring-stone-800">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-stone-400">
            Settle up
          </h2>
          <ul className="space-y-2">
            {transfers.map((t) => (
              <li key={`${t.fromPlayerId}-${t.toPlayerId}`} className="flex items-center gap-2">
                <span className="font-medium">{nameOf.get(t.fromPlayerId)}</span>
                <span className="text-stone-500">pays</span>
                <span className="font-medium">{nameOf.get(t.toPlayerId)}</span>
                <span className="ml-auto font-bold text-felt-400">{formatCents(t.cents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        {round.games.map((g) => {
          const d = derivations.get(g.gameId)
          if (!d) return null
          const open = expanded === g.gameId
          return (
            <div key={g.gameId} className="rounded-2xl bg-stone-900/60 ring-1 ring-stone-800">
              <button
                className="flex w-full items-center justify-between px-4 py-3"
                onClick={() => setExpanded(open ? undefined : g.gameId)}
              >
                <span className="font-semibold capitalize">{g.type}</span>
                <span className="text-sm text-stone-400">{d.summary} {open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div className="border-t border-stone-800 px-4 py-3">
                  <ul className="space-y-1 text-sm text-stone-300">
                    {d.settlement.lines.map((line, i) => (
                      <li key={i}>{line.label}</li>
                    ))}
                    {d.settlement.lines.length === 0 && <li className="text-stone-500">No money moved.</li>}
                  </ul>
                </div>
              )}
            </div>
          )
        })}
      </section>

      <div className="mt-auto space-y-2 pb-2">
        <div className="flex gap-2">
          <BigButton
            variant="outline"
            className="flex-1"
            onClick={() => void buildExport(round).then(downloadExport)}
          >
            Export
          </BigButton>
          {round.status === 'completed' && (
            <BigButton variant="outline" className="flex-1" onClick={() => void reopen()}>
              Reopen
            </BigButton>
          )}
        </div>
        <BigButton className="w-full" onClick={() => navigate('/')}>
          Done
        </BigButton>
      </div>
    </main>
  )
}

/** One tasteful burst, then done — the whole celebration budget. */
function Confetti() {
  const pieces = Array.from({ length: 24 }, (_, i) => i)
  const colors = ['#22c55e', '#4ade80', '#ef4444', '#fafaf9', '#f59e0b']
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0">
      {pieces.map((i) => {
        const x = (i / pieces.length) * 100 + (i % 3) * 2
        return (
          <motion.div
            key={i}
            initial={{ y: -20, x: 0, opacity: 1, rotate: 0 }}
            animate={{ y: 400 + (i % 5) * 60, x: (i % 2 ? 1 : -1) * (20 + (i % 4) * 15), opacity: 0, rotate: 360 }}
            transition={{ duration: 1.6 + (i % 5) * 0.2, ease: 'easeOut' }}
            className="absolute size-2 rounded-sm"
            style={{ left: `${x}%`, backgroundColor: colors[i % colors.length] }}
          />
        )
      })}
    </div>
  )
}
