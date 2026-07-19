import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Course, TeeSet } from '../../engine/core/types'
import { courseRepo } from '../../db/repos'
import { newId } from '../../db/ids'
import { BigButton } from '../../components/BigButton'

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
    teeSets: [{ id: newId(), name: 'White', rating: 70.0, slope: 120 }],
    source: 'user',
    updatedAt: new Date().toISOString(),
    revision: 0,
  }
}

export function CourseEditorScreen() {
  const { courseId } = useParams<{ courseId: string }>()
  const isNew = courseId === undefined
  const navigate = useNavigate()
  const existing = useLiveQuery(
    () => (isNew ? Promise.resolve(null) : courseRepo.get(courseId)),
    [courseId],
  )
  const [draft, setDraft] = useState<Course>()

  if (!isNew && existing === undefined) return null
  const course = draft ?? (isNew ? blankCourse(18) : (existing ?? undefined))
  if (!course) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <p className="text-stone-400">Course not found.</p>
      </main>
    )
  }

  const update = (patch: Partial<Course>) => setDraft({ ...course, ...patch })

  const updateHole = (idx: number, patch: Partial<Course['holes'][number]>) =>
    update({ holes: course.holes.map((h, i) => (i === idx ? { ...h, ...patch } : h)) })

  const updateTee = (idx: number, patch: Partial<TeeSet>) =>
    update({ teeSets: course.teeSets.map((t, i) => (i === idx ? { ...t, ...patch } : t)) })

  // SI must be a permutation of 1..N
  const siSorted = [...course.holes.map((h) => h.strokeIndex)].sort((a, b) => a - b)
  const siValid = siSorted.every((si, i) => si === i + 1)
  const nameValid = course.name.trim().length > 0
  const teesValid = course.teeSets.length > 0 && course.teeSets.every((t) => t.name.trim())

  const save = async () => {
    await courseRepo.put({
      ...course,
      name: course.name.trim(),
      source: 'user',
    })
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
              className="flex items-center gap-2 rounded-2xl bg-stone-900/60 p-3 ring-1 ring-stone-800"
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
                  onFocus={(e) => e.currentTarget.select()}
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
                  onFocus={(e) => e.currentTarget.select()}
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
            </div>
          ))}
          <button
            className="text-sm text-felt-400"
            onClick={() =>
              update({
                teeSets: [
                  ...course.teeSets,
                  { id: newId(), name: '', rating: 70.0, slope: 120 },
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
          {!siValid && <span className="text-xs text-flag-500">SI must use 1–{course.holeCount} once each</span>}
        </div>
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
                          onClick={() => updateHole(i, { par: p })}
                          className={`size-9 rounded-lg text-sm font-bold ${
                            hole.par === p
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
                      onFocus={(e) => e.currentTarget.select()}
                      min={1}
                      max={course.holeCount}
                      value={hole.strokeIndex}
                      aria-label={`hole ${hole.number} stroke index`}
                      onChange={(e) => updateHole(i, { strokeIndex: Number(e.target.value) })}
                      className={`min-h-9 w-14 rounded-lg bg-stone-800 px-2 text-center ring-1 focus:outline-none ${
                        course.holes.filter((h) => h.strokeIndex === hole.strokeIndex).length > 1
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

      <div className="mt-auto pb-2">
        <BigButton
          className="w-full"
          disabled={!nameValid || !siValid || !teesValid}
          onClick={() => void save()}
        >
          Save course
        </BigButton>
      </div>
    </main>
  )
}
