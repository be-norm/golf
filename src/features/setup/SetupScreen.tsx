import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import '../../engine/games'
import { getEngine, listEngines } from '../../engine/catalog'
import { courseHandicap } from '../../engine/core/handicap'
import type { Course, GameConfig, RoundHoles, TeeSet } from '../../engine/core/types'
import { courseRepo, playerRepo, roundRepo } from '../../db/repos'
import { LOCAL_USER, newId } from '../../db/ids'
import { enqueuePushPlayer } from '../../remote/outbox'
import { useAuth } from '../../auth/AuthProvider'
import { BigButton } from '../../components/BigButton'
import { selectOnFocus } from '../../components/inputs'
import { CourseSearch } from '../courses/CourseSearch'
import { PlayerSearch } from '../players/PlayerSearch'
import type { GhinPlayerHit } from '../../remote/ghinSearch'
import { RulesSheet } from '../games/RulesSheet'
import { GameConfigCard, type GameDraft } from './GameConfigCard'

interface PlayerDraft {
  /** stable id — game configs reference THIS, so list edits never remap teams */
  draftId: string
  name: string
  /** WHS index; course handicap is derived from the selected course + tee */
  handicapIndex: number
  /** set when added via GHIN lookup — persisted onto the saved player at tee-off */
  ghinNumber?: string
}

let draftCounter = 0
const nextDraftId = () => `draft-${++draftCounter}-${Math.random().toString(36).slice(2, 8)}`

function computeCourseHandicap(index: number, course: Course | undefined, tee: TeeSet | undefined): number {
  if (!course || !tee) return Math.round(index)
  const par = course.holes.reduce((a, h) => a + h.par, 0)
  return courseHandicap(index, tee.slope, tee.rating, par)
}

export function SetupScreen() {
  const navigate = useNavigate()
  const { activeUserId } = useAuth()
  const courses = useLiveQuery(() => courseRepo.list())
  const roster = useLiveQuery(() => playerRepo.list(activeUserId), [activeUserId])

  const [step, setStep] = useState(0)
  const [courseId, setCourseId] = useState<string>()
  const [teeSetId, setTeeSetId] = useState<string>()
  const [holes, setHoles] = useState<RoundHoles>('full18')
  const [players, setPlayers] = useState<PlayerDraft[]>([])
  const [nameInput, setNameInput] = useState('')
  const [showGhin, setShowGhin] = useState(false)
  const [games, setGames] = useState<GameDraft[]>([])
  const [rulesFor, setRulesFor] = useState<string>()

  const course = courses?.find((c) => c.id === courseId)

  const addPlayer = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed || players.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) return
    // returning players default to their stored index (or legacy course handicap)
    const known = roster?.find((r) => r.name.toLowerCase() === trimmed.toLowerCase())
    setPlayers([
      ...players,
      {
        draftId: nextDraftId(),
        name: trimmed,
        handicapIndex: known?.handicapIndex ?? known?.lastCourseHandicap ?? 0,
      },
    ])
    setNameInput('')
  }

  const addPlayerFromGhin = (hit: GhinPlayerHit) => {
    const name = hit.fullName.trim()
    if (!name || players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return
    setPlayers([
      ...players,
      {
        draftId: nextDraftId(),
        name,
        handicapIndex: hit.handicapIndex ?? 0,
        ghinNumber: hit.ghinNumber,
      },
    ])
  }

  const canContinue =
    step === 0 ? !!course && !!teeSetId : step === 1 ? players.length >= 2 : games.length >= 1

  const draftRoundPlayers = players.map((p) => ({
    playerId: p.draftId,
    name: p.name,
    courseHandicap: computeCourseHandicap(
      p.handicapIndex,
      course,
      course?.teeSets.find((t) => t.id === teeSetId),
    ),
  }))

  const problems =
    step === 2
      ? games.flatMap((g) => {
          const engine = getEngine(g.type)
          if (!engine) return []
          return engine.validateSetup(
            { gameId: 'draft', type: g.type, handicap: g.handicap, config: g.config },
            draftRoundPlayers,
          )
        })
      : []

  const teeOff = async () => {
    if (!course || !teeSetId) return
    const tee = course.teeSets.find((t) => t.id === teeSetId)
    const draftToReal = new Map<string, string>()
    const roundPlayers = await Promise.all(
      players.map(async (p) => {
        const player = await playerRepo.upsertByName(activeUserId, p.name)
        if (p.ghinNumber && !player.ghinNumber) {
          await playerRepo.update(player.id, { ghinNumber: p.ghinNumber })
        }
        const ch = computeCourseHandicap(p.handicapIndex, course, tee)
        await playerRepo.rememberHandicap(player.id, p.handicapIndex, ch)
        draftToReal.set(p.draftId, player.id)
        // Keep the synced roster current — push the just-learned handicap so the
        // saved player isn't names-only on other devices.
        if (activeUserId !== LOCAL_USER) {
          const saved = await playerRepo.get(player.id)
          if (saved) void enqueuePushPlayer(activeUserId, saved)
        }
        return {
          playerId: player.id,
          name: player.name,
          handicapIndex: p.handicapIndex,
          courseHandicap: ch,
          teeSetId,
        }
      }),
    )
    const gameConfigs: GameConfig[] = games.map((g) => ({
      gameId: newId(),
      type: g.type,
      handicap: g.handicap,
      config: resolveDraftPlayers(g.config, draftToReal),
    }))
    const roundId = newId()
    await roundRepo.put({
      id: roundId,
      courseId: course.id,
      courseSnapshot: course,
      teeSetId,
      holes,
      players: roundPlayers,
      games: gameConfigs,
      status: 'live',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deviceId: '',
      schemaVersion: 1,
      userId: activeUserId,
    })
    navigate(`/round/${roundId}/start`, { replace: true })
  }

  return (
    <main className="flex min-h-dvh flex-col gap-5 py-6">
      <header className="flex items-center justify-between pt-2">
        <button className="text-stone-400" onClick={() => (step === 0 ? navigate('/') : setStep(step - 1))}>
          ← Back
        </button>
        <div className="flex gap-1.5">
          {[0, 1, 2].map((s) => (
            <div
              key={s}
              className={`h-1.5 w-8 rounded-full ${s <= step ? 'bg-felt-500' : 'bg-stone-800'}`}
            />
          ))}
        </div>
        <span className="w-12" />
      </header>

      {step === 0 && (
        <section className="flex flex-col gap-4">
          <h1 className="font-display text-sm uppercase text-felt-300">Where are you playing?</h1>
          <CourseSearch
            localIds={new Set(courses?.map((c) => c.id))}
            placeholder="Search any course…"
            onImported={(c) => {
              setCourseId(c.id)
              setTeeSetId(c.teeSets[0]?.id)
              if (c.holeCount === 9) setHoles('front9')
            }}
          />
          <div className="space-y-2">
            {courses?.map((c: Course) => (
              <button
                key={c.id}
                onClick={() => {
                  setCourseId(c.id)
                  setTeeSetId(c.teeSets[0]?.id)
                  if (c.holeCount === 9) setHoles('front9')
                }}
                className={`block w-full px-4 py-4 text-left ${
                  c.id === courseId
                    ? 'pixel border-felt-300 bg-felt-700'
                    : 'pixel border-stone-700 bg-stone-900/70'
                }`}
              >
                <span className="font-semibold">{c.name}</span>
                {c.location && <span className="ml-2 text-sm text-stone-400">{c.location}</span>}
              </button>
            ))}
          </div>
          <Link to="/courses" className="text-sm text-felt-400">
            Manage courses →
          </Link>

          {course && (
            <>
              <div>
                <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Tees</h2>
                <div className="flex flex-wrap gap-2">
                  {course.teeSets.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTeeSetId(t.id)}
                      className={`px-4 py-2.5 text-lg ${
                        t.id === teeSetId
                          ? 'pixel border-felt-300 bg-felt-700'
                          : 'pixel border-stone-700 bg-stone-900/70'
                      }`}
                    >
                      {t.name}
                      <span className="ml-1.5 text-xs font-normal text-stone-400">
                        {t.rating}/{t.slope}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              {course.holeCount === 18 && (
                <div>
                  <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Holes</h2>
                  <div className="flex gap-2">
                    {(
                      [
                        ['full18', '18 holes'],
                        ['front9', 'Front 9'],
                        ['back9', 'Back 9'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => setHoles(value)}
                        className={`px-4 py-2.5 text-lg ${
                          holes === value ? 'pixel border-felt-300 bg-felt-700' : 'pixel border-stone-700 bg-stone-900/70'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {step === 1 && (
        <section className="flex flex-col gap-4">
          <h1 className="font-display text-sm uppercase text-felt-300">Who's playing?</h1>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              addPlayer(nameInput)
            }}
          >
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Player name"
              autoCapitalize="words"
              className="min-h-12 flex-1 rounded-xl bg-stone-900 px-4 ring-1 ring-stone-700 placeholder:text-stone-500 focus:outline-none focus:ring-felt-500"
            />
            <BigButton type="submit" variant="outline" className="min-h-12">
              Add
            </BigButton>
          </form>

          <div>
            <button
              onClick={() => setShowGhin((v) => !v)}
              className="font-display text-[10px] uppercase text-felt-400"
            >
              {showGhin ? '× Close GHIN lookup' : '🔍 Look up on GHIN'}
            </button>
            {showGhin && (
              <div className="mt-2">
                <PlayerSearch
                  onPick={addPlayerFromGhin}
                  addedGhins={
                    new Set(players.map((p) => p.ghinNumber).filter((n): n is string => !!n))
                  }
                />
              </div>
            )}
          </div>

          {roster && roster.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {roster
                .filter((r) => !players.some((p) => p.name.toLowerCase() === r.name.toLowerCase()))
                .slice(0, 8)
                .map((r) => (
                  <button
                    key={r.id}
                    onClick={() => addPlayer(r.name)}
                    className="rounded-full bg-stone-900/80 px-3.5 py-1.5 text-sm text-stone-300 ring-1 ring-stone-700"
                  >
                    + {r.name}
                  </button>
                ))}
            </div>
          )}

          <ul className="space-y-2">
            {players.map((p, i) => (
              <li
                key={p.name}
                className="flex items-center justify-between rounded-2xl bg-stone-900/60 px-4 py-3 ring-1 ring-stone-800"
              >
                <div className="flex items-center gap-2">
                  <button
                    aria-label={`remove ${p.name}`}
                    className="text-stone-500"
                    onClick={() => setPlayers(players.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                  <span className="font-semibold">{p.name}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <label className="flex items-center gap-1.5 text-xs uppercase text-stone-500">
                    Index
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.1"
                      min={-10}
                      max={54}
                      value={p.handicapIndex}
                      onFocus={selectOnFocus}
                      aria-label={`${p.name} handicap index`}
                      onChange={(e) =>
                        setPlayers(
                          players.map((pl, j) =>
                            j === i ? { ...pl, handicapIndex: Number(e.target.value) || 0 } : pl,
                          ),
                        )
                      }
                      className="min-h-11 w-20 border-2 border-stone-700 bg-stone-800 px-2 text-center text-lg text-stone-100 focus:border-felt-500 focus:outline-none"
                    />
                  </label>
                  <span className="font-display min-w-16 text-center text-[10px] text-felt-300">
                    HCP{' '}
                    {computeCourseHandicap(
                      p.handicapIndex,
                      course,
                      course?.teeSets.find((t) => t.id === teeSetId),
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {players.length > 0 && players.length < 2 && (
            <p className="text-sm text-stone-500">Add at least 2 players.</p>
          )}
        </section>
      )}

      {step === 2 && (
        <section className="flex flex-col gap-4">
          <h1 className="font-display text-sm uppercase text-felt-300">What's the game?</h1>
          {listEngines().map((engine) => {
            const active = games.find((g) => g.type === engine.type)
            const playable =
              players.length >= engine.meta.minPlayers && players.length <= engine.meta.maxPlayers
            return (
              <GameConfigCard
                key={engine.type}
                engine={engine}
                playable={playable}
                players={players}
                draft={active}
                onToggle={() => {
                  if (active) setGames(games.filter((g) => g.type !== engine.type))
                  else
                    setGames([
                      ...games,
                      {
                        type: engine.type,
                        handicap: engine.defaultHandicap(),
                        config: engine.defaultConfig(draftRoundPlayers),
                      },
                    ])
                }}
                onChange={(next) => setGames(games.map((g) => (g.type === engine.type ? next : g)))}
                onRules={() => setRulesFor(engine.type)}
              />
            )
          })}
          {problems.length > 0 && (
            <ul className="rounded-xl bg-flag-600/10 p-3 text-sm text-flag-500 ring-1 ring-flag-600/40">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="mt-auto pb-2">
        {step < 2 ? (
          <BigButton className="w-full" disabled={!canContinue} onClick={() => setStep(step + 1)}>
            Continue
          </BigButton>
        ) : (
          <BigButton
            className="w-full"
            disabled={!canContinue || problems.length > 0}
            onClick={() => void teeOff()}
          >
            Tee off ⛳
          </BigButton>
        )}
      </div>

      <RulesSheet type={rulesFor} onClose={() => setRulesFor(undefined)} />
    </main>
  )
}

/**
 * Game configs are drafted against stable per-draft ids before real player
 * ids exist; swap them at round creation. Stable ids (not list positions)
 * mean adding/removing players never silently remaps teams or rotations —
 * a stale reference instead fails engine validateSetup and blocks tee-off.
 */
function resolveDraftPlayers(config: unknown, draftToReal: Map<string, string>): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return draftToReal.get(value) ?? value
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
    }
    return value
  }
  return walk(config)
}
