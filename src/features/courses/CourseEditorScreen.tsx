import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Course, TeeSet } from '../../engine/core/types'
import { courseRepo, ownsCourse } from '../../db/repos'
import { newId } from '../../db/ids'
import { isStrokeIndexPermutation, looksLikeEighteenHoleRating } from '../../engine/core/tees'
import { useAuth } from '../../auth/AuthProvider'
import { BigButton } from '../../components/BigButton'
import { PixelSprite } from '../../components/PixelSprite'
import { selectOnFocus } from '../../components/inputs'

/** A rating is for the holes the card covers, so a nine's is about half an 18's —
 *  seeding 70.0 on a 9-hole course would hand out ~34 phantom strokes. */
function defaultTee(holeCount: 9 | 18): Omit<TeeSet, 'id' | 'name'> {
  return { rating: holeCount === 9 ? 35.0 : 70.0, slope: 120 }
}

function blankCourse(holeCount: 9 | 18): Course {
  return {
    id: newId(),
    name: '',
    location: '',
    holeCount,
    holes: Array.from({ length: holeCount }, (_, i) => ({
      number: i + 1,
      par: 4,
      strokeIndex: i + 1,
    })),
    teeSets: [{ id: newId(), name: 'White', ...defaultTee(holeCount) }],
    source: 'user',
    updatedAt: new Date().toISOString(),
    revision: 0,
  }
}

export function CourseEditorScreen() {
  const { courseId } = useParams<{ courseId: string }>()
  const isNew = courseId === undefined
  const navigate = useNavigate()
  const location = useLocation()
  const { activeUserId } = useAuth()
  // Resolves a missing card to null so it's distinguishable from undefined
  // (still loading) — with the same sentinel for both, "Course not found" was
  // unreachable and a GC'd card (fork + Back, or a removal pulled from
  // another device) rendered a permanent blank page.
  const existing = useLiveQuery(
    () => (isNew ? Promise.resolve(null) : courseRepo.get(courseId).then((c) => c ?? null)),
    [courseId],
  )
  // A scorecard scan navigates here with a pre-filled draft to review.
  const scannedDraft = (location.state as { draft?: Course } | null)?.draft
  const [draft, setDraft] = useState<Course | undefined>(() => scannedDraft)
  // Which par/SI row the holes table edits: the course-wide default, or a tee id.
  const [teeTab, setTeeTab] = useState<'default' | string>('default')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // The draft comes first: a removal pulled mid-edit must not blank the
  // screen under unsaved changes — saving simply re-creates the card.
  const course = draft ?? (isNew ? blankCourse(18) : (existing ?? undefined))
  if (!isNew && existing === undefined && !draft) return null // still loading
  if (!course) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4">
        <p className="text-stone-400">Course not found.</p>
        <Link to="/courses" className="text-felt-400">
          ← Courses
        </Link>
      </main>
    )
  }

  const update = (patch: Partial<Course>) => setDraft({ ...course, ...patch })

  const updateHole = (idx: number, patch: Partial<Course['holes'][number]>) =>
    update({ holes: course.holes.map((h, i) => (i === idx ? { ...h, ...patch } : h)) })

  const updateTee = (idx: number, patch: Partial<TeeSet>) =>
    update({ teeSets: course.teeSets.map((t, i) => (i === idx ? { ...t, ...patch } : t)) })

  // The holes table edits either the course-wide default (HoleCore) or one tee's
  // own per-hole row (`teeTab`); a tee with no row shows the default values as
  // its starting point, and editing materializes its array.
  const teeIdx = course.teeSets.findIndex((t) => t.id === teeTab)
  const activeTee = teeIdx >= 0 ? course.teeSets[teeIdx] : undefined
  const activePars = activeTee?.pars ?? course.holes.map((h) => h.par)
  const activeSIs = activeTee?.strokeIndexes ?? course.holes.map((h) => h.strokeIndex)

  const setHolePar = (i: number, par: number) => {
    if (!activeTee) return updateHole(i, { par })
    const pars = [...activePars]
    pars[i] = par
    updateTee(teeIdx, { pars })
  }
  const setHoleSI = (i: number, strokeIndex: number) => {
    if (!activeTee) return updateHole(i, { strokeIndex })
    const strokeIndexes = [...activeSIs]
    strokeIndexes[i] = strokeIndex
    updateTee(teeIdx, { strokeIndexes })
  }

  const activeSiValid = isStrokeIndexPermutation(activeSIs)
  // Save requires every stroke-index row (default + any per-tee rows) valid.
  const invalidTee = course.teeSets.find(
    (t) => t.strokeIndexes && !isStrokeIndexPermutation(t.strokeIndexes),
  )
  const siValid =
    isStrokeIndexPermutation(course.holes.map((h) => h.strokeIndex)) && !invalidTee
  const nameValid = course.name.trim().length > 0
  // Block save on a rating in the wrong dimension, same as a bad SI row: both
  // mean "this course would compute wrong handicaps", and this course publishes
  // to the shared library. The per-tee warning below shows which tee to fix.
  const misratedTee = course.teeSets.find((t) => looksLikeEighteenHoleRating(course, t))
  const teesValid =
    course.teeSets.length > 0 && course.teeSets.every((t) => t.name.trim()) && !misratedTee

  const save = async () => {
    // FORKING A COURSE THAT ISN'T OURS (MAI-78). Correcting an API or seed
    // card used to save locally and stop there, so the golfer who actually
    // plays there — the one who knows the stroke indexes are wrong — kept the
    // fix to themselves forever. It has to be a fork rather than an edit of
    // the shared row: RLS only lets a user update rows they created (rightly —
    // the alternative is anyone rewriting any course), and the original's ODbL
    // provenance has to survive. `ownsCourse` decides — ownership, never
    // `source` (see its doc for the legacy population). No modal in any case
    // (decided on MAI-78): when overwrite is possible it's obviously what you
    // want, and when it isn't, a prompt would offer something the server
    // refuses — so your own updates in place silently, anyone else's forks
    // silently and the list screen states the consequence after the fact.
    // Decide off the loaded card while it's there, else off the draft — which
    // still carries the ORIGINAL createdBy. Gating on `existing != null` alone
    // minted a trap: a foreign card GC'd mid-edit (its removal pulled from
    // another device) left `forking` false, and Save stamped our createdBy
    // onto the foreign id — the permanent RLS-dead-push state ownsCourse
    // exists to prevent (delta-review finding).
    const forking = !isNew && !ownsCourse(existing ?? course, activeUserId)
    const base: Course = {
      ...course,
      name: course.name.trim(),
      source: 'user',
      createdBy: activeUserId,
    }
    const saved = forking
      ? // one repo transaction: the fork lands, publishes, and the original's
        // membership retires together, so a crash can't leave both rows in
        // the library or a saved fork that never reaches the shared library.
        // sourceId keeps the ODbL provenance chain on the published row;
        // revision 0 because a fork is a new course, not revision N+1 of
        // somebody else's.
        await courseRepo.fork(activeUserId, course.id, {
          ...base,
          id: newId(),
          sourceId: course.id,
          revision: 0,
        })
      : // saveAuthored, not save: the republish of our own row rides inside
        // the repo transaction, same crash guarantee as the fork. Guests
        // publish at claim time (the LOCAL_USER gate inside the repo holds).
        await courseRepo.saveAuthored(activeUserId, base)
    navigate(
      '/courses',
      forking
        ? { state: { notice: `Saved as your version of ${saved.name || 'this course'}.` } }
        : undefined,
    )
  }

  const remove = async () => {
    // membership drop + tombstone are one transaction inside the repo, so a
    // crash between them can't remove the course locally with nothing queued
    await courseRepo.remove(activeUserId, course.id)
    navigate('/courses')
  }

  return (
    <main className="flex min-h-dvh flex-col gap-5 py-6">
      <header className="flex items-center justify-between">
        <Link to="/courses" className="text-stone-400">
          ← Courses
        </Link>
        <h1 className="font-display text-xs uppercase text-felt-300">{isNew ? 'New course' : 'Edit course'}</h1>
        <span className="w-14" />
      </header>

      {/* The scan landed. Says what came back and — with `animate-stamp` — that
          it just arrived, because the editor otherwise looks identical whether
          you scanned a card or tapped "New course" and typed nothing. */}
      {scannedDraft && (
        <p className="animate-stamp pixel flex items-center justify-center gap-3 border-felt-500 bg-felt-900/60 px-4 py-3">
          <PixelSprite name="scan" scale={2} />
          <span className="font-display text-[10px] uppercase text-felt-200">
            Scorecard read · {scannedDraft.holes.length} holes · check it over
          </span>
        </p>
      )}

      <section className="space-y-3">
        <input
          value={course.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Course name"
          className="min-h-12 w-full rounded-xl bg-stone-900 px-4 text-lg font-semibold ring-1 ring-stone-700 placeholder:text-stone-500 focus:outline-none focus:ring-felt-500"
        />
        <input
          value={course.location ?? ''}
          onChange={(e) => update({ location: e.target.value })}
          placeholder="City, State (optional)"
          className="min-h-11 w-full rounded-xl bg-stone-900 px-4 ring-1 ring-stone-700 placeholder:text-stone-500 focus:outline-none focus:ring-felt-500"
        />
        {isNew && !draft && (
          <div className="flex gap-2">
            {([18, 9] as const).map((n) => (
              <button
                key={n}
                onClick={() => setDraft(blankCourse(n))}
                className={`rounded-xl px-4 py-2 text-sm font-semibold ring-1 ${
                  course.holeCount === n ? 'bg-felt-800 ring-felt-500' : 'bg-stone-900 ring-stone-700'
                }`}
              >
                {n} holes
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Tees</h2>
        <div className="space-y-2">
          {course.teeSets.map((tee, i) => (
            <div
              key={tee.id}
              className="flex flex-wrap items-center gap-2 rounded-2xl bg-stone-900/60 p-3 ring-1 ring-stone-800"
            >
              <input
                value={tee.name}
                onChange={(e) => updateTee(i, { name: e.target.value })}
                placeholder="Name"
                className="min-h-10 w-24 rounded-lg bg-stone-800 px-2 text-sm font-semibold ring-1 ring-stone-700 focus:outline-none"
              />
              <label className="flex items-center gap-1 text-xs text-stone-400">
                Rating
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  onFocus={selectOnFocus}
                  value={tee.rating}
                  onChange={(e) => updateTee(i, { rating: Number(e.target.value) })}
                  className="min-h-10 w-16 rounded-lg bg-stone-800 px-2 text-sm text-stone-100 ring-1 ring-stone-700 focus:outline-none"
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-stone-400">
                Slope
                <input
                  type="number"
                  inputMode="numeric"
                  onFocus={selectOnFocus}
                  value={tee.slope}
                  onChange={(e) => updateTee(i, { slope: Number(e.target.value) })}
                  className="min-h-10 w-14 rounded-lg bg-stone-800 px-2 text-sm text-stone-100 ring-1 ring-stone-700 focus:outline-none"
                />
              </label>
              {course.teeSets.length > 1 && (
                <button
                  aria-label={`remove ${tee.name} tees`}
                  className="ml-auto px-1 text-stone-500"
                  onClick={() => update({ teeSets: course.teeSets.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              )}
              {/* Same heuristic the importers repair by — but here we block save
                  rather than silently rewrite a number the user typed, so a bad
                  rating can't publish to the shared library. */}
              {looksLikeEighteenHoleRating(course, tee) && (
                <p className="w-full text-xs text-flag-500">
                  That looks like an 18-hole rating — a 9-hole card's rating is about half. Fix it to
                  save.
                </p>
              )}
            </div>
          ))}
          <button
            className="text-sm text-felt-400"
            onClick={() =>
              update({
                teeSets: [
                  ...course.teeSets,
                  { id: newId(), name: '', ...defaultTee(course.holeCount) },
                ],
              })
            }
          >
            + Add tee set
          </button>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-[10px] uppercase text-stone-400">
            Holes — par & stroke index
          </h2>
          {!activeSiValid ? (
            <span className="text-xs text-flag-500">SI must use 1–{course.holeCount} once each</span>
          ) : invalidTee ? (
            <span className="text-xs text-flag-500">
              Fix {invalidTee.name || 'a tee'}’s SI — 1–{course.holeCount} once each
            </span>
          ) : null}
        </div>
        {/* Which row to edit: the course-wide default, or a specific tee's own
            par/SI (when the card rates tees separately). */}
        <div className="mb-2 flex flex-wrap gap-1">
          {(['default', ...course.teeSets.map((t) => t.id)] as const).map((id) => {
            const tee = id === 'default' ? undefined : course.teeSets.find((t) => t.id === id)
            const isActive = id === 'default' ? !activeTee : activeTee?.id === id
            const hasOwn = !!(tee?.strokeIndexes || tee?.pars)
            return (
              <button
                key={id}
                onClick={() => setTeeTab(id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 ${
                  isActive ? 'bg-felt-800 ring-felt-500' : 'bg-stone-900 ring-stone-700 text-stone-400'
                }`}
              >
                {id === 'default' ? 'Default' : (tee?.name || 'Tee')}
                {hasOwn && <span className="ml-1 text-felt-400">•</span>}
              </button>
            )
          })}
        </div>
        {activeTee && (
          <p className="mb-2 text-xs text-stone-500">
            Editing the {activeTee.name || 'tee'} tee's own par & SI. Tees without their own row use
            Default.
          </p>
        )}
        <div className="overflow-hidden rounded-2xl ring-1 ring-stone-800">
          <table className="w-full text-center text-sm tabular-nums">
            <thead className="bg-stone-900 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="py-2">Hole</th>
                <th>Par</th>
                <th>SI</th>
              </tr>
            </thead>
            <tbody>
              {course.holes.map((hole, i) => (
                <tr key={hole.number} className="border-t border-stone-800 bg-stone-900/40">
                  <td className="py-1.5 font-semibold">{hole.number}</td>
                  <td>
                    <div className="inline-flex gap-1">
                      {[3, 4, 5].map((p) => (
                        <button
                          key={p}
                          onClick={() => setHolePar(i, p)}
                          className={`size-9 rounded-lg text-sm font-bold ${
                            activePars[i] === p
                              ? 'bg-felt-700 text-white'
                              : 'bg-stone-800 text-stone-400'
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td>
                    <input
                      type="number"
                      inputMode="numeric"
                      onFocus={selectOnFocus}
                      min={1}
                      max={course.holeCount}
                      value={activeSIs[i]}
                      aria-label={`hole ${hole.number} stroke index`}
                      onChange={(e) => setHoleSI(i, Number(e.target.value))}
                      className={`min-h-9 w-14 rounded-lg bg-stone-800 px-2 text-center ring-1 focus:outline-none ${
                        activeSIs.filter((s) => s === activeSIs[i]).length > 1
                          ? 'ring-flag-600 text-flag-500'
                          : 'ring-stone-700'
                      }`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-auto space-y-3 pb-2">
        <BigButton
          className="w-full"
          disabled={!nameValid || !siValid || !teesValid}
          onClick={() => void save()}
        >
          Save course
        </BigButton>
        {!isNew &&
          (confirmDelete ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => void remove()}
                className="min-h-11 min-w-0 flex-1 truncate rounded-xl bg-stone-900 px-3 text-sm font-semibold text-flag-500 ring-1 ring-flag-600"
              >
                Delete {course.name.trim() || 'this course'}?
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="min-h-11 rounded-xl px-4 text-sm text-stone-400 ring-1 ring-stone-700"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-full py-2 text-center text-sm text-flag-500"
            >
              Delete course
            </button>
          ))}
      </div>
    </main>
  )
}
