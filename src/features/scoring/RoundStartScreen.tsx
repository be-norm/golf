import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import '../../engine/games'
import { getEngine, type GameEngine } from '../../engine/catalog'
import { formatCents } from '../../engine/core/money'
import type { GameConfig, HandicapSettings } from '../../engine/core/types'
import { roundRepo } from '../../db/repos'
import { BigButton } from '../../components/BigButton'
import { selectOnFocus } from '../../components/inputs'
import { RulesSheet } from '../games/RulesSheet'
import { useRound } from './useRound'

const HOLES_LABEL: Record<string, string> = {
  full18: '18 holes',
  front9: 'Front 9',
  back9: 'Back 9',
}

/** "Net · 80% · off the low" / "Gross — no strokes" */
function handicapLine(h: HandicapSettings): string {
  if (h.mode === 'gross') return 'Gross — no strokes'
  return `Net · ${h.allowancePct}%${h.reference === 'offLow' ? ' · off the low' : ''}`
}

/** Short human config chips from the engine's declared fields. teams/rotation
 *  render separately (as name lists), so they're skipped here. */
function configChips(engine: GameEngine, config: Record<string, unknown>): string[] {
  const chips: string[] = []
  for (const f of engine.configFields) {
    const v = config[f.key]
    if (f.kind === 'money' && typeof v === 'number') chips.push(`${f.label} ${formatCents(v)}`)
    else if (f.kind === 'boolean' && v) chips.push(f.label)
    else if (f.kind === 'select') {
      const opt = f.options.find((o) => o.value === v)
      if (opt) chips.push(`${f.label}: ${opt.label}`)
    }
  }
  return chips
}

/** Fat-finger guard on a hand-typed course handicap. The upper bound sits above
 *  any real WHS course handicap — the max 54.0 index on a steep slope lands in
 *  the low 70s — so a legitimate value is never clipped, while "142" is still
 *  bounded (and visibly wrong for the user to correct). */
const clampHandicap = (n: number) => Math.max(-10, Math.min(74, Math.round(n)))

/**
 * One player's course handicap — the escape hatch before the first score, for a
 * wrong index, a course whose rating is off, or a stroke everyone just agreed to
 * give. `handicapIndex` is deliberately left alone: it records what the player
 * reported, while `courseHandicap` is what the engine consumes.
 *
 * The typed text is LOCAL state, and it COMMITS ON BLUR, not per keystroke. A
 * controlled input reading straight from the round (a Dexie round-trip away)
 * snaps back to the stale value between keystrokes — type "22" over 14 and you
 * get 142 — so local state owns what's on screen. And committing per keystroke
 * would persist a half-typed value: clear the box to retype and it writes 0;
 * type "10" over "18" and the stroke rows below flash the CH-1 allocation. Blur
 * settles it once: an empty/NaN entry, or one that didn't change the number,
 * reverts and writes nothing.
 */
function HandicapField({
  name,
  courseHandicap,
  onCommit,
}: {
  name: string
  courseHandicap: number
  onCommit: (ch: number) => void
}) {
  const [text, setText] = useState(String(courseHandicap))
  const commit = () => {
    const raw = text.trim()
    if (raw === '' || Number.isNaN(Number(raw))) return setText(String(courseHandicap))
    const ch = clampHandicap(Number(raw))
    setText(String(ch))
    if (ch !== courseHandicap) onCommit(ch)
  }
  return (
    <input
      type="number"
      inputMode="numeric"
      min={-10}
      max={74}
      value={text}
      onFocus={selectOnFocus}
      aria-label={`${name} course handicap`}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      className="min-h-11 w-20 border-2 border-stone-700 bg-stone-800 px-2 text-center text-lg text-stone-100 focus:border-felt-500 focus:outline-none"
    />
  )
}

/**
 * First-tee summary shown once after tee-off and re-openable from the scoring
 * screen. Its job: make the otherwise-invisible handicap allocation legible —
 * how many strokes each player gets, per game, before a single hole is scored.
 */
export function RoundStartScreen() {
  const { roundId } = useParams()
  const navigate = useNavigate()
  const view = useRound(roundId)
  const [rulesFor, setRulesFor] = useState<string>()

  if (view === undefined) return <main className="p-6 text-stone-400">Loading…</main>
  if (view === null)
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6">
        <p className="text-stone-400">Round not found.</p>
        <Link className="text-felt-400" to="/">
          ← Home
        </Link>
      </main>
    )

  const { round, ctx } = view
  const nameOf = new Map(round.players.map((p) => [p.playerId, p.name]))
  const tee = round.courseSnapshot.teeSets.find((t) => t.id === round.teeSetId)
  const lowCH = Math.min(...round.players.map((p) => p.courseHandicap))
  const anyScored = round.players.some((p) =>
    ctx.holesPlayed.some((h) => ctx.gross.get(p.playerId)?.get(h) !== undefined),
  )

  const goToCard = () => navigate(`/round/${round.id}`, { replace: true })

  return (
    <main className="flex min-h-dvh flex-col gap-5 py-6">
      <header className="flex items-center justify-between pt-2">
        <Link className="text-stone-400" to={anyScored ? `/round/${round.id}` : '/'}>
          ← {anyScored ? 'Card' : 'Home'}
        </Link>
        <span className="w-12" />
      </header>

      <div className="text-center">
        <h1 className="font-display text-sm uppercase text-coin-400">★ First tee ★</h1>
        <p className="mt-2 text-xl font-bold">{round.courseSnapshot.name}</p>
        <p className="mt-1 text-sm text-stone-400">
          {tee ? `${tee.name} ${tee.rating}/${tee.slope} · ` : ''}
          {HOLES_LABEL[round.holes] ?? round.holes}
          {/* a nine played twice around — say so before anyone wonders what
              "hole 14" means on a 9-hole course */}
          {round.courseSnapshot.holes.some((h) => h.loop && h.loop.nth > 1) &&
            ' · two loops of the nine'}
        </p>
      </div>

      {/* Handicaps belong to the round, not to one game — and they're only
          honest to change while the card is blank, so they lock on first score. */}
      {round.games.some((g) => g.handicap.mode === 'net') && (
        <section className="pixel border-stone-700 bg-stone-900/60 p-4">
          <h2 className="font-display text-[10px] uppercase text-stone-400">Course handicaps</h2>
          {/* Once scoring starts the per-game rows below already carry each CH,
              so this collapses to the reason it can't be changed. */}
          {!anyScored && (
            <ul className="mt-2 space-y-1.5">
              {round.players.map((p) => (
                <li key={p.playerId} className="flex items-center justify-between gap-2">
                  <span className="font-medium">{p.name}</span>
                  <HandicapField
                    name={p.name}
                    courseHandicap={p.courseHandicap}
                    onCommit={(ch) => void roundRepo.setCourseHandicap(round.id, p.playerId, ch)}
                  />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-stone-500">
            {anyScored
              ? 'Locked — scoring has started.'
              : 'Tap to adjust. These lock once the first score is in.'}
          </p>
        </section>
      )}

      <section className="flex flex-col gap-4">
        {round.games.map((game: GameConfig) => {
          const engine = getEngine(game.type)
          if (!engine) return null
          const config = (game.config ?? {}) as Record<string, unknown>
          const chips = configChips(engine, config)
          const isNet = game.handicap.mode === 'net'
          const rows = round.players
            .map((p) => ({
              p,
              strokes: ctx.holesPlayed.reduce(
                (s, h) => s + ctx.strokesFor(game.gameId, p.playerId, h),
                0,
              ),
            }))
            .sort((a, b) => (isNet ? b.strokes - a.strokes : 0))

          return (
            <div key={game.gameId} className="pixel border-felt-500 bg-felt-900/60 p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="font-display text-sm uppercase text-felt-300">{engine.meta.name}</h2>
                <button
                  aria-label={`${engine.meta.name} rules`}
                  onClick={() => setRulesFor(game.type)}
                  className="font-display text-[10px] uppercase text-felt-400"
                >
                  Rules ▶
                </button>
              </div>

              {chips.length > 0 && (
                <p className="mt-1 text-sm text-stone-300">{chips.join(' · ')}</p>
              )}

              {/* teams / rotation, by name */}
              {engine.configFields.map((f) => {
                if (f.kind === 'teams') {
                  const t = config[f.key] as { a?: string[]; b?: string[] } | undefined
                  if (!t?.a || !t?.b) return null
                  const side = (ids: string[]) => ids.map((id) => nameOf.get(id) ?? id).join(', ')
                  return (
                    <p key={f.key} className="mt-1 text-sm text-stone-400">
                      {side(t.a)} <span className="text-stone-600">vs</span> {side(t.b)}
                    </p>
                  )
                }
                if (f.kind === 'rotation') {
                  const order = config[f.key] as string[] | undefined
                  if (!order) return null
                  return (
                    <p key={f.key} className="mt-1 text-sm text-stone-400">
                      {order.map((id) => nameOf.get(id) ?? id).join(' → ')}
                    </p>
                  )
                }
                return null
              })}

              <p className="font-display mt-2 text-[10px] uppercase text-coin-400">
                {handicapLine(game.handicap)}
              </p>

              {isNet ? (
                <ul className="mt-2 space-y-1.5">
                  {rows.map(({ p, strokes }) => (
                    <li key={p.playerId} className="flex items-baseline justify-between">
                      <span className="font-medium">
                        {p.name}
                        {game.handicap.reference === 'offLow' && p.courseHandicap === lowCH && (
                          <span className="ml-1.5 text-xs text-stone-500">· low</span>
                        )}
                      </span>
                      <span className="text-stone-300">
                        <span className="text-stone-500">CH {p.courseHandicap} · </span>
                        <span className="font-semibold text-felt-200">{strokes}</span>{' '}
                        {strokes === 1 ? 'stroke' : 'strokes'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-stone-300">
                  {round.players.map((p) => p.name).join(' · ')}
                </p>
              )}
            </div>
          )
        })}
      </section>

      <div className="mt-auto pb-2">
        <BigButton className="w-full" onClick={goToCard}>
          {anyScored ? 'Back to the card ⛳' : 'Start scoring ⛳'}
        </BigButton>
      </div>

      <RulesSheet type={rulesFor} onClose={() => setRulesFor(undefined)} />
    </main>
  )
}
