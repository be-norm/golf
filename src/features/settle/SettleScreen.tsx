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
        <h1 className="font-display text-xs uppercase text-felt-300">{round.courseSnapshot.name}</h1>
        <Link to={`/round/${round.id}/card`} className="text-sm text-stone-400">
          Card
        </Link>
      </header>

      <section className="pixel border-felt-500 bg-felt-900/60 p-5">
        <h2 className="font-display mb-4 text-center text-xs uppercase text-coin-400">
          ★ Final standings ★
        </h2>
        <ul className="space-y-2.5">
          {ranked.map((p, i) => (
            <motion.li
              key={p.playerId}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.15, duration: 0.12, ease: (t: number) => Math.ceil(t * 3) / 3 }}
              className="flex items-center justify-between"
            >
              <span className="text-xl font-semibold">
                <span className="font-display mr-2 text-[10px] text-stone-500">{i + 1}P</span>
                {i === 0 && (combined[p.playerId] ?? 0) > 0 ? '🏆 ' : ''}
                {p.name}
              </span>
              <span
                className={`font-display text-sm ${
                  (combined[p.playerId] ?? 0) > 0
                    ? 'text-felt-300'
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
        <section className="pixel border-stone-700 bg-stone-900/70 p-5">
          <h2 className="font-display mb-3 text-[10px] uppercase text-stone-400">Settle up</h2>
          <ul className="space-y-2">
            {transfers.map((t) => (
              <li key={`${t.fromPlayerId}-${t.toPlayerId}`} className="flex items-center gap-2 text-lg">
                <span className="font-medium">{nameOf.get(t.fromPlayerId)}</span>
                <span className="text-stone-500">▶ pays ▶</span>
                <span className="font-medium">{nameOf.get(t.toPlayerId)}</span>
                <span className="font-display ml-auto text-xs text-coin-400">{formatCents(t.cents)}</span>
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
            <div key={g.gameId} className="pixel border-stone-700 bg-stone-900/70">
              <button
                className="flex w-full items-center justify-between px-4 py-3"
                onClick={() => setExpanded(open ? undefined : g.gameId)}
              >
                <span className="font-display text-[10px] uppercase text-felt-300">{g.type}</span>
                <span className="text-lg text-stone-400">{d.summary} {open ? '▼' : '▶'}</span>
              </button>
              {open && (
                <div className="border-t-2 border-stone-800 px-4 py-3">
                  <ul className="space-y-1 text-lg text-stone-300">
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

/** One 8-bit confetti burst, then done — the whole celebration budget. */
function Confetti() {
  const pieces = Array.from({ length: 28 }, (_, i) => i)
  const colors = ['#22c55e', '#7dff66', '#ff4444', '#fafaf9', '#ffd23e']
  // chunky steps easing: pixels fall on a grid, not a curve
  const stepped = (n: number) => (t: number) => Math.ceil(t * n) / n
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0">
      {pieces.map((i) => {
        const x = (i / pieces.length) * 100 + (i % 3) * 2
        const size = 6 + (i % 3) * 4
        return (
          <motion.div
            key={i}
            initial={{ y: -20, x: 0, opacity: 1 }}
            animate={{
              y: 380 + (i % 5) * 70,
              x: (i % 2 ? 1 : -1) * (16 + (i % 4) * 18),
              opacity: 0,
            }}
            transition={{ duration: 1.4 + (i % 5) * 0.25, ease: stepped(9 + (i % 4)) }}
            className="absolute"
            style={{ left: `${x}%`, width: size, height: size, backgroundColor: colors[i % colors.length] }}
          />
        )
      })}
    </div>
  )
}
