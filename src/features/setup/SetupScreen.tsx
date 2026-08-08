import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import '../../engine/games'
import { getEngine, type GameEngine } from '../../engine/catalog'
import { gameLabel } from '../../engine/label'
import { courseHandicapForTee } from '../../engine/core/handicap'
import { applyTee, doubleNine } from '../../engine/core/tees'
import type { Course, GameConfig, RoundHoles, TeeSet } from '../../engine/core/types'
import { courseRepo, ownsCourse, playerRepo, roundRepo } from '../../db/repos'
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
import { reconcileRoles } from './roles'
import { SideBetRow } from './SideBetRow'
import { GamePickerSheet } from './GamePickerSheet'
import { CourseSourceMark } from '../../components/CourseSourceMark'

interface PlayerDraft {
  /** stable id — game configs reference THIS, so list edits never remap teams */
  draftId: string
  name: string
  /** WHS index; course handicap is derived from the selected course + tee */
  handicapIndex: number
  /** set when added via GHIN lookup — persisted onto the saved player at tee-off */
  ghinNumber?: string
}

/**
 * The wizard's steps, named. Splitting the course picker in two meant
 * renumbering seven bare integers by hand, and a missed one fails silently and
 * specifically: leaving `problems` on the players step would have validated
 * nothing on the games step and let an invalid game tee off.
 */
const STEP = { course: 0, tees: 1, players: 2, games: 3 } as const
type Step = (typeof STEP)[keyof typeof STEP]
const LAST_STEP = STEP.games

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
  // the picker offers YOUR library (MAI-76) — which is also what makes
  // "played there ⇒ it's in My Courses" hold by construction: a course can
  // only be selected from this list, and search-import saves before selecting
  const courses = useLiveQuery(() => courseRepo.list(activeUserId), [activeUserId])
  const roster = useLiveQuery(() => playerRepo.list(activeUserId), [activeUserId])

  const [step, setStep] = useState<Step>(STEP.course)
  /**
   * The course you chose, held as the CARD and not just its id.
   *
   * Deriving it from the live library made setup depend on membership twice
   * over: right after a search-import the query hasn't re-run yet, so step 1
   * rendered "that course has left your library" about the course you had just
   * successfully added — and a genuine removal mid-setup silently un-rated
   * every handicap and turned Tee off into a no-op. A round freezes its own
   * `courseSnapshot` anyway (invariant #4), so what you're playing does not
   * depend on the library still listing it.
   */
  const [picked, setPicked] = useState<Course>()
  const [teeSetId, setTeeSetId] = useState<string>()
  const [holes, setHoles] = useState<RoundHoles>('full18')
  const [players, setPlayers] = useState<PlayerDraft[]>([])
  const [nameInput, setNameInput] = useState('')
  const [showGhin, setShowGhin] = useState(false)
  const [games, setGames] = useState<GameDraft[]>([])
  const [rulesFor, setRulesFor] = useState<string>()
  const [picker, setPicker] = useState<'main' | 'side'>()
  /**
   * Auto-open the picker ONCE, the first time step 2 is reached with nothing
   * chosen — the empty state is otherwise a dead end behind a disabled button.
   *
   * A ref, and it never resets: re-opening whenever step 2 is empty would trap
   * the user, because empty is exactly the state you are in when you dismissed
   * the sheet to go back a step.
   */
  const autoOpened = useRef(false)

  /**
   * Picking a course now advances the step, which unmounts the button that was
   * just activated — focus would land back on <body> with nothing announced.
   * Every other transition rides the persistent Continue button, which keeps
   * its focus, so this moves focus to the new step's question instead.
   */
  const heading = useRef<HTMLHeadingElement>(null)
  const landed = useRef(false)
  useEffect(() => {
    if (!landed.current) {
      landed.current = true // don't steal focus on first paint
      return
    }
    heading.current?.focus()
  }, [step])

  // prefer the live row, so an edit to the card reaches this screen; fall back
  // to the copy you picked, so a lagging query or a removal can't erase it
  const course = courses?.find((c) => c.id === picked?.id) ?? picked

  // Pick a course + its first tee, and reset the hole range to that course's
  // default — a nine to its nine, an eighteen to the full round. Without the
  // reset a 'front9' left over from a previously-selected 9-hole course would
  // silently tee an 18-hole course off as a partial round ('front9' is valid
  // for both, so `playedHoles` wouldn't correct it).
  const selectCourse = (c: Course) => {
    // Re-tapping the course you already chose is navigation, not a new choice.
    // Now that the tees live on their own screen, resetting here would throw
    // away a hole range picked two screens ago for no visible reason.
    if (c.id === picked?.id) return setStep(STEP.tees)
    setPicked(c)
    setTeeSetId(c.teeSets[0]?.id)
    setHoles(c.holeCount === 9 ? 'front9' : 'full18')
    // …and move on. Tees and holes belong to the course you just chose, so
    // asking for them beneath a list of every OTHER course invited the reader
    // to think the list was still the question.
    setStep(STEP.tees)
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
  // Self-correcting, like `playedHoles` above and for the same reason: the card
  // is a live query and its tee set can change shape under a stale `teeSetId`.
  // Falling back to the first tee keeps the screen and teeOff agreeing.
  const playedTee = played?.teeSets.find((t) => t.id === teeSetId) ?? played?.teeSets[0]
  const activeTeeId = course?.teeSets.find((t) => t.id === teeSetId)?.id ?? course?.teeSets[0]?.id

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
    step === STEP.course
      ? !!course
      : step === STEP.tees
        ? // the RESOLVED tee, not the id: a stale id that no longer names a tee
          // on this card would pass a truthiness check and then dead-end at
          // teeOff's own guard, with Tee off doing nothing and saying nothing
          !!course && !!playedTee
        : step === STEP.players
          ? players.length >= 2
          : games.length >= 1

  const draftRoundPlayers = players.map((p) => ({
    playerId: p.draftId,
    name: p.name,
    courseHandicap: computeCourseHandicap(p.handicapIndex, played, playedTee),
  }))

  useEffect(() => {
    if (step !== STEP.games || games.length > 0 || autoOpened.current) return
    autoOpened.current = true
    setPicker('main')
  }, [step, games.length])

  // A draft IS a GameConfig — same instance id, same shape — so `roleOf` and
  // `validateSetup` can read the round being built exactly as they read a
  // played one, with no adapter and no synthetic ids.
  const draftGames: GameConfig[] = games
  // Laid out by the section the USER picked into, not by `roleOf`. The two
  // agree wherever the difference matters (see `reconcileRoles`); where they
  // don't, the screen owes the user the answer they gave it.
  const mainDrafts = games.filter((g) => g.section === 'main')
  const sideDrafts = games.filter((g) => g.section === 'side')

  const problems =
    step === LAST_STEP
      ? // DEDUPED: two drafts with identical settings each report the same
        // duplicate string, and the list below keys on the message.
        [
          ...new Set(
            games.flatMap((g) => {
              const engine = getEngine(g.type)
              if (!engine) return []
              return engine.validateSetup(
                g,
                draftRoundPlayers,
                draftGames.filter((s) => s.gameId !== g.gameId),
              )
            }),
          ),
        ]
      : []

  const addGame = (engine: GameEngine, section: 'main' | 'side') => {
    setGames(
      reconcileRoles([
        ...games,
        {
          gameId: newId(),
          type: engine.type,
          section,
          handicap: engine.defaultHandicap(),
          config: engine.defaultConfig(draftRoundPlayers),
        },
      ]),
    )
    setPicker(undefined)
  }

  const updateGame = (next: GameDraft) =>
    setGames(games.map((g) => (g.gameId === next.gameId ? next : g)))

  const removeGame = (gameId: string) =>
    setGames(reconcileRoles(games.filter((g) => g.gameId !== gameId)))

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
      // Minted when the game was chosen, not here: the draft has been keyed by
      // this id all along, so validation and `roleOf` saw the same identities
      // the round will.
      gameId: g.gameId,
      type: g.type,
      // Absent for almost every round, and absent means "derive it" rather than
      // "main" — only a placement `roleOf` disagrees with is stored. See
      // `reconcileRoles`.
      ...(g.role ? { role: g.role } : {}),
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
        <button className="text-stone-400" onClick={() => (step === STEP.course ? navigate('/') : setStep((step - 1) as Step))}>
          ← Back
        </button>
        <div className="flex gap-1.5">
          {Object.values(STEP).map((s) => (
            <div
              key={s}
              className={`h-1.5 w-8 rounded-full ${s <= step ? 'bg-felt-500' : 'bg-stone-800'}`}
            />
          ))}
        </div>
        <span className="w-12" />
      </header>

      {step === STEP.course && (
        <section className="flex flex-col gap-4">
          <h1 ref={heading} tabIndex={-1} className="font-display text-sm uppercase text-felt-300 outline-none">
            Where are you playing?
          </h1>
          <CourseSearch
            localIds={new Set(courses?.map((c) => c.id))}
            intent="play"
            placeholder="Search any course…"
            onPicked={(c) => selectCourse(c)}
          />
          <div className="space-y-2">
            {courses?.map((c: Course) => (
              <button
                key={c.id}
                onClick={() => selectCourse(c)}
                className={`block w-full px-4 py-4 text-left ${
                  c.id === picked?.id
                    ? 'pixel border-felt-300 bg-felt-700'
                    : 'pixel border-stone-700 bg-stone-900/70'
                }`}
              >
                <span className="font-semibold">{c.name}</span>
                <CourseSourceMark source={c.source} mine={ownsCourse(c, activeUserId)} />
                {c.location && <span className="ml-2 text-sm text-stone-400">{c.location}</span>}
              </button>
            ))}
          </div>
          <ScanButton />
          <Link to="/courses" className="text-sm text-felt-400">
            Manage courses →
          </Link>
        </section>
      )}

      {/* Tees and holes are questions ABOUT the chosen course, so they get the
          screen to themselves. Sharing step 0 with the course list meant
          choosing a tee while every other course sat above it still looking
          like the live question — and Back is how you change your mind. */}
      {step === STEP.tees && (
        <section className="flex flex-col gap-4">
          <div>
            <h1 ref={heading} tabIndex={-1} className="font-display text-sm uppercase text-felt-300 outline-none">
              How are you playing it?
            </h1>
            {course && (
              <p className="mt-2 text-lg font-semibold">
                {course.name}
                {/* the mark travels with the name (MAI-77): this is the last
                    screen before the card freezes into the round, and two
                    versions of one course read identically without it */}
                <CourseSourceMark source={course.source} mine={ownsCourse(course, activeUserId)} />
                {course.location && (
                  <span className="ml-2 text-sm font-normal text-stone-400">{course.location}</span>
                )}
              </p>
            )}
          </div>

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
                        t.id === activeTeeId
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

      {step === STEP.players && (
        <section className="flex flex-col gap-4">
          <h1 ref={heading} tabIndex={-1} className="font-display text-sm uppercase text-felt-300 outline-none">
            Who's playing?
          </h1>
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

      {step === STEP.games && (
        <section className="flex flex-col gap-5">
          {/* `ref`/`tabIndex` from MAI-79: auto-advance unmounts the button the
              user just activated, so focus is moved here rather than dropped to
              <body>. */}
          <h1
            ref={heading}
            tabIndex={-1}
            className="font-display text-sm uppercase text-felt-300 outline-none"
          >
            What are you playing?
          </h1>

          {/* CHOSEN ONLY. Listing every registered engine was fine at five games
              and unusable at twenty-five; the picker is the entry point now,
              and this screen is the answer. */}
          <div className="flex flex-col gap-3">
            <h2 className="font-display text-[10px] uppercase text-stone-400">Main game(s)</h2>
            {mainDrafts.length === 0 ? (
              <div className="pixel border-stone-700 bg-stone-900/70 px-4 py-6 text-center">
                <p className="mb-3 text-stone-500">Nothing picked yet</p>
                <BigButton variant="outline" onClick={() => setPicker('main')}>
                  + Choose a game
                </BigButton>
              </div>
            ) : (
              <>
                {mainDrafts.map((draft) => {
                  const engine = getEngine(draft.type)
                  if (!engine) return null
                  return (
                    <GameConfigCard
                      key={draft.gameId}
                      engine={engine}
                      label={gameLabel(draft, draftGames)}
                      players={players}
                      draft={draft}
                      onChange={updateGame}
                      onRemove={() => removeGame(draft.gameId)}
                      onRules={() => setRulesFor(draft.type)}
                    />
                  )
                })}
                <button
                  onClick={() => setPicker('main')}
                  className="font-display self-center text-[10px] uppercase text-felt-400"
                >
                  + Add another game
                </button>
              </>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="font-display text-[10px] uppercase text-stone-400">Side bets</h2>
            {sideDrafts.map((draft) => {
              const engine = getEngine(draft.type)
              if (!engine) return null
              return (
                <SideBetRow
                  key={draft.gameId}
                  engine={engine}
                  label={gameLabel(draft, draftGames)}
                  players={players}
                  draft={draft}
                  onChange={updateGame}
                  onRemove={() => removeGame(draft.gameId)}
                  onRules={() => setRulesFor(draft.type)}
                />
              )
            })}
            <button
              onClick={() => setPicker('side')}
              className="font-display self-center text-[10px] uppercase text-felt-400"
            >
              {sideDrafts.length === 0 ? '+ Add a side bet' : '+ More side bets'}
            </button>
          </div>

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
        {step < LAST_STEP ? (
          <BigButton className="w-full" disabled={!canContinue} onClick={() => setStep((step + 1) as Step)}>
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

      <GamePickerSheet
        open={picker !== undefined}
        section={picker ?? 'main'}
        playerCount={players.length}
        chosenCounts={games.reduce(
          (counts, g) => counts.set(g.type, (counts.get(g.type) ?? 0) + 1),
          new Map<string, number>(),
        )}
        onPick={(engine) => addGame(engine, picker ?? 'main')}
        onClose={() => setPicker(undefined)}
      />

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
