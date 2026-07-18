import { Link } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { courseRepo } from '../../db/repos'

export function CourseListScreen() {
  const courses = useLiveQuery(() => courseRepo.list())

  return (
    <main className="flex min-h-dvh flex-col gap-4 py-6">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-stone-400">
          ← Home
        </Link>
        <h1 className="font-bold">Courses</h1>
        <span className="w-12" />
      </header>

      <Link
        to="/courses/new"
        className="block rounded-2xl bg-felt-900/60 px-4 py-4 text-center font-semibold ring-1 ring-felt-700 active:bg-felt-800/60"
      >
        + New course
      </Link>

      <ul className="space-y-2">
        {courses?.map((c) => (
          <li key={c.id}>
            <Link
              to={`/courses/${c.id}/edit`}
              className="block rounded-2xl bg-stone-900/60 px-4 py-3 ring-1 ring-stone-800 active:bg-stone-800/60"
            >
              <span className="font-semibold">{c.name}</span>
              <span className="ml-2 text-sm text-stone-400">
                {c.holeCount} holes{c.location ? ` · ${c.location}` : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
