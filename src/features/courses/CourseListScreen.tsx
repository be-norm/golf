import { Link, useNavigate } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { courseRepo } from '../../db/repos'
import { CourseSearch } from './CourseSearch'

export function CourseListScreen() {
  const navigate = useNavigate()
  const courses = useLiveQuery(() => courseRepo.list())

  return (
    <main className="flex min-h-dvh flex-col gap-4 py-6">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-stone-400">
          ← Home
        </Link>
        <h1 className="font-display text-xs uppercase text-felt-300">Courses</h1>
        <span className="w-12" />
      </header>

      <CourseSearch localIds={new Set(courses?.map((c) => c.id))} />

      <Link
        to="/courses/new"
        className="pixel-press font-display block border-felt-600 bg-felt-900/60 px-4 py-4 text-center text-xs uppercase"
      >
        + New course
      </Link>

      <section>
        <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">My library</h2>
        <ul className="space-y-2">
          {courses?.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => navigate(`/courses/${c.id}/edit`)}
                className="pixel block w-full border-stone-700 bg-stone-900/70 px-4 py-3 text-left"
              >
                <span className="text-lg font-semibold">{c.name}</span>
                <span className="ml-2 text-stone-400">
                  {c.holeCount} holes{c.location ? ` · ${c.location}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-auto pb-2 text-center text-sm text-stone-600">
        Course search includes data from{' '}
        <a href="https://opengolfapi.org" className="underline">
          OpenGolfAPI
        </a>
        , available under{' '}
        <a href="https://opendatacommons.org/licenses/odbl/1-0/" className="underline">
          ODbL
        </a>
        .
      </footer>
    </main>
  )
}
