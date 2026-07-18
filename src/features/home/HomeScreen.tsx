import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { roundRepo } from '../../db/repos'
import { holesForRange } from '../../engine/core/context'
import { importRound } from '../settle/exportRound'
import { InstallHint } from '../../pwa/InstallHint'

export function HomeScreen() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState(false)
  const liveRound = useLiveQuery(() => roundRepo.liveRound())
  const recent = useLiveQuery(() => roundRepo.listRecent(8))
  const completed = recent?.filter((r) => r.status === 'completed') ?? []

  return (
    <main className="flex min-h-dvh flex-col gap-6 py-8">
      <header className="flex items-center gap-3 pt-2">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-felt-800 text-2xl">
          ⛳
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Golf</h1>
          <p className="text-sm text-felt-300">Games between friends</p>
        </div>
      </header>

      {liveRound && (
        <Link
          to={`/round/${liveRound.id}`}
          className="block rounded-3xl bg-felt-700 p-5 shadow-xl shadow-felt-950/50 active:scale-[0.99]"
        >
          <p className="text-sm font-medium uppercase tracking-wide text-felt-200">Resume round</p>
          <p className="mt-1 text-xl font-bold">{liveRound.courseSnapshot.name}</p>
          <p className="mt-1 text-sm text-felt-100">
            {liveRound.players.map((p) => p.name).join(' · ')}
          </p>
          <p className="mt-3 text-sm text-felt-200">
            {holesForRange(liveRound.holes).length} holes ·{' '}
            {liveRound.games.length} game{liveRound.games.length === 1 ? '' : 's'} → tap to continue
          </p>
        </Link>
      )}

      <Link
        to="/setup"
        className="block rounded-3xl bg-felt-900/60 p-5 text-center ring-1 ring-felt-700 active:bg-felt-800/60"
      >
        <span className="text-lg font-semibold">New round</span>
      </Link>

      <InstallHint />

      {completed.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-stone-400">
            Recent rounds
          </h2>
          <ul className="space-y-2">
            {completed.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/round/${r.id}/settle`}
                  className="block rounded-2xl bg-stone-900/60 px-4 py-3 ring-1 ring-stone-800"
                >
                  <span className="font-medium">{r.courseSnapshot.name}</span>
                  <span className="ml-2 text-sm text-stone-400">
                    {new Date(r.startedAt).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-auto pb-2 text-center">
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            void file
              .text()
              .then(importRound)
              .then(() => setImportError(false))
              .catch(() => setImportError(true))
            e.target.value = ''
          }}
        />
        <div className="flex items-center justify-center gap-4">
          <Link to="/courses" className="text-sm text-stone-500">
            Courses
          </Link>
          <button className="text-sm text-stone-500" onClick={() => fileRef.current?.click()}>
            Import round
          </button>
          <Link to="/diagnostics" className="text-sm text-stone-600">
            ⚙
          </Link>
        </div>
        {importError && <p className="mt-1 text-sm text-flag-500">That file isn't a golf round export.</p>}
      </footer>
    </main>
  )
}
