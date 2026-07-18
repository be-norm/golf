import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { clearErrorLog, readErrorLog, type DiagnosticEntry } from '../../pwa/diagnostics'

export function DiagnosticsScreen() {
  const [entries, setEntries] = useState<DiagnosticEntry[]>(() => readErrorLog())
  const [storage, setStorage] = useState<string>()
  const [persisted, setPersisted] = useState<boolean>()

  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => {
      if (e.usage !== undefined && e.quota !== undefined) {
        setStorage(`${(e.usage / 1024 / 1024).toFixed(1)} MB of ${(e.quota / 1024 / 1024 / 1024).toFixed(1)} GB`)
      }
    })
    void navigator.storage?.persisted?.().then(setPersisted)
  }, [])

  return (
    <main className="flex min-h-dvh flex-col gap-4 py-6">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-stone-400">
          ← Home
        </Link>
        <h1 className="font-bold">Diagnostics</h1>
        <span className="w-12" />
      </header>

      <section className="rounded-2xl bg-stone-900/60 p-4 text-sm ring-1 ring-stone-800">
        <p>
          Version <span className="font-mono text-felt-300">{__APP_VERSION__}</span>
        </p>
        <p className="mt-1">Storage: {storage ?? '—'}</p>
        <p className="mt-1">
          Persistent storage: {persisted === undefined ? '—' : persisted ? 'granted ✓' : 'not granted'}
        </p>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-stone-400">
            Error log ({entries.length})
          </h2>
          {entries.length > 0 && (
            <button
              className="text-sm text-flag-500"
              onClick={() => {
                clearErrorLog()
                setEntries([])
              }}
            >
              Clear
            </button>
          )}
        </div>
        {entries.length === 0 ? (
          <p className="text-sm text-stone-500">No errors recorded. 🎉</p>
        ) : (
          <ul className="space-y-2">
            {[...entries].reverse().map((e, i) => (
              <li key={i} className="rounded-xl bg-stone-900/60 p-3 text-xs ring-1 ring-stone-800">
                <p className="text-stone-500">{e.at}</p>
                <p className="mt-1 font-medium text-flag-500">{e.message}</p>
                {e.stack && (
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-stone-500">{e.stack}</pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
