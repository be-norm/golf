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
      <header className="pt-6 text-center">
        <img src={`${import.meta.env.BASE_URL}pwa-192x192.png`} alt="" className="mx-auto size-16 [image-rendering:pixelated]" />
        <h1 className="font-display mt-3 text-3xl uppercase text-felt-300 [text-shadow:4px_4px_0_rgb(0_0_0/0.6)]">
          Golf
        </h1>
        <p className="mt-2 text-lg text-felt-400">— games between friends —</p>
      </header>

      {liveRound && (
        <Link
          to={`/round/${liveRound.id}`}
          className="pixel-press block border-felt-300 bg-felt-700 p-5"
        >
          <p className="font-display text-[10px] uppercase text-coin-400">
            <span className="animate-blink">▶</span> Resume round
          </p>
          <p className="mt-2 text-2xl font-bold">{liveRound.courseSnapshot.name}</p>
          <p className="mt-1 text-lg text-felt-100">
            {liveRound.players.map((p) => p.name).join(' · ')}
          </p>
          <p className="mt-2 text-lg text-felt-200">
            {holesForRange(liveRound.holes).length} holes ·{' '}
            {liveRound.games.length} game{liveRound.games.length === 1 ? '' : 's'}
          </p>
        </Link>
      )}

      <Link
        to="/setup"
        className="pixel-press font-display block border-felt-600 bg-felt-900/60 p-5 text-center text-xs uppercase"
      >
        {!liveRound && <span className="animate-blink mr-2 text-coin-400">▶</span>}
        New round
      </Link>

      <InstallHint />

      {completed.length > 0 && (
        <section>
          <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Recent rounds</h2>
          <ul className="space-y-2.5">
            {completed.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/round/${r.id}/settle`}
                  className="pixel block border-stone-700 bg-stone-900/70 px-4 py-3"
                >
                  <span className="text-lg font-medium">{r.courseSnapshot.name}</span>
                  <span className="ml-2 text-stone-400">
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
