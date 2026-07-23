import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import '../../engine/games'
import { getEngine, listEngines } from '../../engine/catalog'
import { courseHandicapForTee } from '../../engine/core/handicap'
import { applyTee, doubleNine } from '../../engine/core/tees'
import type { Course, GameConfig, RoundHoles, TeeSet } from '../../engine/core/types'
import { courseRepo, playerRepo, roundRepo } from '../../db/repos'
import { LOCAL_USER, newId } from '../../db/ids'
import { enqueuePushPlayer } from '../../remote/outbox'
import { useAuth } from '../../auth/AuthProvider'
import { BigButton } from '../../components/BigButton'
import { selectOnFocus } from '../../components/inputs'
import { CourseSearch } from '../courses/CourseSearch'
import { ScanButton } from '../courses/ScanButton'
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
  if (!course) return Math.round(index)
  // Uses the selected tee's own par (a "4/3" hole scores as its tee-specific
  // par) and halves the index on a 9-hole course — see courseHandicapForTee.
  return courseHandicapForTee(index, course, tee)
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

  // Pick a course + its first tee, and reset the hole range to that course's
  // default — a nine to its nine, an eighteen to the full round. Without the
  // reset a 'front9' left over from a previously-selected 9-hole course would
  // silently tee an 18-hole course off as a partial round ('front9' is valid
  // for both, so `playedHoles` wouldn't correct it).
  const selectCourse = (c: Course) => {
    setCourseId(c.id)
    setTeeSetId(c.teeSets[0]?.id)
    setHoles(c.holeCount === 9 ? 'front9' : 'full18')
  }

  const holeOptions: [RoundHoles, string][] =
    course?.holeCount === 9
      ? [
          ['front9', '9 holes'],
          ['full18', '18 (twice around)'],
        ]
      : [
          ['full18', '18 holes'],
          ['front9', 'Front 9'],
          ['back9', 'Back 9'],
        ]
  // `courses` is a live query, so the selected course can change shape under a
  // stale selection (a 'back9' left over from an 18-hole record would tee off
  // with ZERO playable holes). Always play a range this course actually offers.
  const playedHoles = holeOptions.some(([v]) => v === holes) ? holes : holeOptions[0]![0]

  // A nine played twice around scores as an 18-hole course. `played` is the
  // course as it will actually be played — the handicap chips and the frozen
  // snapshot both read from it, so what you see on this screen is what tees off.
  const playTwice = course?.holeCount === 9 && playedHoles === 'full18'
  const played = useMemo(
    () => (course && playTwice ? doubleNine(course) : course),
    [course, playTwice],
  )
  const playedTee = played?.teeSets.find((t) => t.id === teeSetId)

  // Handicaps get quietly scaled for a nine; say so rather than let the numbers
  // look wrong.
  const holesNote =
    course?.holeCount === 9
      ? playTwice
        ? 'Two loops of the nine — full 18-hole handicaps.'
        : "Nine-hole handicaps: half your index, off the nine's own rating."
      : playedHoles === 'full18'
        ? undefined
        : 'Nine of eighteen — everyone plays off half their course handicap.'

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
    courseHandicap: computeCourseHandicap(p.handicapIndex, played, playedTee),
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
    // guard on the RESOLVED tee, not just the id: an unresolvable id would fall
    // through to the un-rated handicap path and drop the tee's par/SI overlay
    if (!course || !played || !playedTee) return
    const draftToReal = new Map<string, string>()
    const roundPlayers = await Promise.all(
      players.map(async (p) => {
        const player = await playerRepo.upsertByName(activeUserId, p.name)
        if (p.ghinNumber && !player.ghinNumber) {
          await playerRepo.update(player.id, { ghinNumber: p.ghinNumber })
        }
        const ch = computeCourseHandicap(p.handicapIndex, played, playedTee)
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
      // Freeze the PLAYED tee's stroke index / par into the snapshot so the
      // engine (which reads courseSnapshot.holes) scores off the right tee.
      // `played` is already doubled when a nine is being played twice around;
      // courseId still points at the 9-hole course in the library.
      courseSnapshot: applyTee(played, playedTee),
      teeSetId: playedTee.id,
      holes: playedHoles,
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
            onImported={(c) => selectCourse(c)}
          />
          <div className="space-y-2">
            {courses?.map((c: Course) => (
              <button
                key={c.id}
                onClick={() => selectCourse(c)}
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
          <ScanButton />
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
              <div>
                <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Holes</h2>
                <div className="flex gap-2">
                  {holeOptions.map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => setHoles(value)}
                      className={`px-4 py-2.5 text-lg ${
                        playedHoles === value
                          ? 'pixel border-felt-300 bg-felt-700'
                          : 'pixel border-stone-700 bg-stone-900/70'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {holesNote && <p className="mt-2 text-xs text-stone-500">{holesNote}</p>}
              </div>
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
                    HCP {computeCourseHandicap(p.handicapIndex, played, playedTee)}
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
