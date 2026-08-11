import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { motion } from 'motion/react'
import '../../engine/games'
import { formatCents, formatCentsSigned } from '../../engine/core/money'
import { eventStore } from '../../db/eventStore'
import { roundRepo } from '../../db/repos'
import { LOCAL_USER } from '../../db/ids'
import { enqueueDeleteRound } from '../../remote/outbox'
import { useRound } from '../scoring/useRound'
import { stepped } from '../../lib/motion'
import { BigButton } from '../../components/BigButton'
import { PixelSprite } from '../../components/PixelSprite'
import { DetailLines } from '../../components/DetailLines'
import { buildSummaryCard, NETS_TO_NOTHING } from './summaryCard'
import { ShareSheet } from './ShareSheet'

export function SettleScreen() {
  const { roundId } = useParams<{ roundId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const view = useRound(roundId)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  /**
   * CONFETTI IS FOR FINISHING, NOT FOR VISITING. It used to fire on mount, so
   * it also fired every time somebody opened a finished round from Home's
   * recent list — a celebration for scrolling back through last month's golf.
   *
   * `finish()` is the only thing that says so, via navigation state, because
   * the round itself cannot: `round/completed` is just as present in the log on
   * the fiftieth visit as on the first.
   *
   * CAPTURED ON MOUNT, then spent — in that order and not the other. Reading it
   * live and clearing it in an effect flips it false on the very next render
   * and tears the confetti down a frame after it starts, which looks exactly
   * like a rendering bug and is one. Spending it matters because history state
   * survives a reload, and a reload is a visit like any other.
   */
  const [justFinished] = useState(
    () => (location.state as { justFinished?: boolean } | null)?.justFinished === true,
  )
  useEffect(() => {
    if (justFinished) navigate('.', { replace: true, state: null })
    // once: the point is to spend the flag. Re-running on any other `location`
    // change would replace history entries this screen never navigated to.
  }, [justFinished, navigate])
  // One derivation, two renderers: this screen and the shareable image paint
  // the same model, so their numbers cannot drift apart. Memoised because the
  // share sheet repaints whenever this object changes identity.
  const card = useMemo(
    () => (view ? buildSummaryCard(view.round, view.ctx, view.derivations) : null),
    [view],
  )

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
  if (!view || !card) return null

  const { round } = view

  const reopen = async () => {
    await eventStore.append(round.id, [{ type: 'round/reopened' }])
    await roundRepo.put({ ...round, status: 'live' })
    navigate(`/round/${round.id}`)
  }

  const remove = async () => {
    const owner = round.userId ?? LOCAL_USER
    await roundRepo.delete(round.id)
    // tombstone the cloud copy for owned rounds so other devices converge
    if (owner !== LOCAL_USER) await enqueueDeleteRound(owner, round.id)
    navigate('/')
  }

  return (
    <main className="flex min-h-dvh flex-col gap-5 py-6">
      {justFinished && <Confetti />}
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
          {card.standings.map((s, i) => (
            <motion.li
              key={s.playerId}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.15, duration: 0.12, ease: stepped(3) }}
              className="flex items-center justify-between gap-3"
            >
              <span className="min-w-0 truncate text-xl font-semibold">
                <span className="font-display mr-2 text-[10px] text-stone-500">{i + 1}P</span>
                {s.leader ? '🏆 ' : ''}
                {s.name}
              </span>
              {/* a long name yields; the amount never breaks mid-token */}
              <span
                className={`font-display shrink-0 whitespace-nowrap text-sm ${
                  s.cents > 0
                    ? 'text-felt-300'
                    : s.cents < 0
                      ? 'text-flag-500'
                      : 'text-stone-400'
                }`}
              >
                {formatCentsSigned(s.cents)}
              </span>
            </motion.li>
          ))}
        </ul>
      </section>

      {card.settle.length > 0 && (
        <section className="pixel border-stone-700 bg-stone-900/70 p-5">
          <h2 className="font-display mb-3 text-[10px] uppercase text-stone-400">Settle up</h2>
          <ul className="space-y-4">
            {card.settle.map((c) => (
              <li key={c.playerId}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-lg font-medium">{c.name} collects</span>
                  <span className="font-display shrink-0 text-lg tabular-nums text-coin-400">
                    {formatCents(c.totalCents)}
                  </span>
                </div>
                <ul className="mt-1.5 space-y-1 border-l-2 border-stone-800 pl-3">
                  {c.from.map((f) => (
                    <li
                      key={f.playerId}
                      className="flex items-baseline justify-between gap-3 text-stone-300"
                    >
                      <span className="min-w-0 truncate">
                        <span className="mr-1 text-stone-600">←</span>
                        {f.name}
                      </span>
                      <span className="font-display shrink-0 text-sm tabular-nums text-stone-400">
                        {formatCents(f.cents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        {card.games.map((g) => (
          <div key={g.gameId} className="pixel border-stone-700 bg-stone-900/70 px-4 py-3">
            <div className="font-display mb-2 flex items-baseline gap-2 text-xs uppercase text-felt-300">
              {g.name}
              {g.allowance && <span className="text-stone-400">{g.allowance}</span>}
            </div>
            {/* Nassau ships a per-bet ledger (F9/B9/18 + presses); games without
                one arrive as plain money lines. Both come from the model. */}
            {g.lines.length === 0 ? (
              <p className="text-stone-500">No money moved.</p>
            ) : g.kind === 'ledger' ? (
              <DetailLines lines={g.lines} valueClass="text-stone-300" />
            ) : (
              <ul className="space-y-1 text-lg text-stone-300">
                {g.lines.map((line, i) => (
                  <li key={i}>
                    {line.value}
                    {/* What the line did to the player it names, in the same
                        green/red the totals below use — so a reader can see at
                        a glance who collected and who paid, without adding the
                        stakes up themselves. */}
                    {line.amountCents !== undefined && (
                      <span
                        className={line.amountCents > 0 ? 'text-felt-300' : 'text-flag-500'}
                      >
                        {' '}
                        ({formatCentsSigned(line.amountCents)})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {/* Below a rule: what the game MOVED, then what it has to SAY.
                The money tier answers "where did my total come from" — the
                lines above are bets, and a pushed bet is still a bet (MAI-88).
                Notes keep their place beneath it and their dimmer weight, so
                "3 skins died unwon" can still never be read as a payout. */}
            <div className="mt-2.5 space-y-1 border-t border-stone-800 pt-2.5">
              {g.money.length === 0 ? (
                <p className="text-stone-500">{NETS_TO_NOTHING}</p>
              ) : (
                <p className="flex flex-wrap gap-x-2 gap-y-0.5">
                  {g.money.map((m) => (
                    <span key={m.playerId} className="whitespace-nowrap text-stone-300">
                      {m.name}{' '}
                      <span
                        className={m.cents > 0 ? 'text-felt-300' : 'text-flag-500'}
                      >
                        {formatCentsSigned(m.cents)}
                      </span>
                    </span>
                  ))}
                </p>
              )}
              {g.notes.map((note, i) => (
                <p key={i} className="text-stone-500">
                  {note}
                </p>
              ))}
            </div>
          </div>
        ))}
      </section>

      <div className="mt-auto space-y-2 pb-2">
        <div className="flex gap-2">
          <BigButton variant="outline" className="flex-1" onClick={() => setShareOpen(true)}>
            Share
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
        {confirmDelete ? (
          <div className="flex gap-2">
            <BigButton variant="ghost" className="flex-1" onClick={() => setConfirmDelete(false)}>
              Cancel
            </BigButton>
            <BigButton variant="danger" className="flex-1" onClick={() => void remove()}>
              Delete round
            </BigButton>
          </div>
        ) : (
          <button
            className="pixel-press mx-auto mt-1 block border-flag-500 bg-flag-600/10 px-5 py-2 text-sm font-medium text-flag-500"
            onClick={() => setConfirmDelete(true)}
          >
            Delete round
          </button>
        )}
      </div>

      <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} round={round} card={card} />
    </main>
  )
}

/**
 * One 8-bit burst when the round ends — the biggest moment the app has, and
 * still one burst.
 *
 * Every fourth piece is a spinning coin rather than a square, because the thing
 * being celebrated is a settled card: the money is the point. Kept sparse on
 * purpose — 28 sprites all animating their own strips is a lot of work for a
 * phone that has been recording scores for four hours, and the squares carry
 * the shape of the thing anyway.
 */
function Confetti() {
  const pieces = Array.from({ length: 28 }, (_, i) => i)
  const colors = ['#22c55e', '#7dff66', '#ff4444', '#fafaf9', '#ffd23e']
  // ONE BURST MEANS IT ENDS. The pieces reach `opacity: 0` after ~2.4s, but the
  // coins spin on a looping CSS animation, so leaving them mounted means seven
  // invisible sprites animating for as long as somebody reads the settlement or
  // fiddles with the share sheet. Unmounting is what makes the burst finite —
  // trimming the count only made the leak smaller.
  const [done, setDone] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setDone(true), 2600)
    return () => clearTimeout(t)
  }, [])
  if (done) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0">
      {pieces.map((i) => {
        const x = (i / pieces.length) * 100 + (i % 3) * 2
        const size = 6 + (i % 3) * 4
        const isCoin = i % 4 === 0
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
            style={
              isCoin
                ? { left: `${x}%` }
                : { left: `${x}%`, width: size, height: size, backgroundColor: colors[i % colors.length] }
            }
          >
            {isCoin && <PixelSprite name="coin" scale={1} loop />}
          </motion.div>
        )
      })}
    </div>
  )
}
