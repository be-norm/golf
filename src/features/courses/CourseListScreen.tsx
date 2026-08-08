import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { courseRepo, ownsCourse } from '../../db/repos'
import { useAuth } from '../../auth/AuthProvider'
import { CourseSourceMark } from '../../components/CourseSourceMark'
import { CourseSearch } from './CourseSearch'
import { ScanButton } from './ScanButton'

export function CourseListScreen() {
  const navigate = useNavigate()
  const { activeUserId } = useAuth()
  // the signed-in user's OWN library — on a shared phone each account sees
  // only its own list (MAI-76)
  const courses = useLiveQuery(() => courseRepo.list(activeUserId), [activeUserId])
  // A fork (MAI-78) states its consequence here, after the fact — an
  // unobtrusive line, never a blocking prompt. Captured once, then scrubbed
  // from history state so a reload or back-navigation doesn't replay it.
  const location = useLocation()
  const [notice] = useState(() => (location.state as { notice?: string } | null)?.notice)
  useEffect(() => {
    if (notice) void navigate('/courses', { replace: true, state: null })
  }, [notice, navigate])

  return (
    <main className="flex min-h-dvh flex-col gap-4 py-6">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-stone-400">
          ← Home
        </Link>
        <h1 className="font-display text-xs uppercase text-felt-300">Courses</h1>
        <span className="w-12" />
      </header>

      {notice && <p className="text-sm text-coin-400">{notice}</p>}

      <CourseSearch localIds={new Set(courses?.map((c) => c.id))} />

      <div className="grid grid-cols-2 gap-2">
        <Link
          to="/courses/new"
          className="pixel-press font-display block border-felt-600 bg-felt-900/60 px-4 py-4 text-center text-xs uppercase"
        >
          + New course
        </Link>
        <ScanButton />
      </div>

      <section>
        <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">My library</h2>
        {courses && courses.length === 0 && (
          <p className="text-sm text-stone-500">
            No courses saved yet — search above to add one (it's cached here once you pick it).
          </p>
        )}
        <ul className="space-y-2">
          {courses?.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => navigate(`/courses/${c.id}/edit`)}
                className="pixel block w-full border-stone-700 bg-stone-900/70 px-4 py-3 text-left"
              >
                <span className="text-lg font-semibold">{c.name}</span>
                {/* `mine` off ownsCourse, not source: without it a course you
                    typed in yourself reads "community" on your own library */}
                <CourseSourceMark source={c.source} mine={ownsCourse(c, activeUserId)} />
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
        </a>{' '}
        (
        <a href="https://opendatacommons.org/licenses/odbl/1-0/" className="underline">
          ODbL
        </a>
        ) and{' '}
        <a href="https://golfcourseapi.com" className="underline">
          GolfCourseAPI
        </a>
        .
      </footer>
    </main>
  )
}
