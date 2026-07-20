import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { clearErrorLog, readErrorLog, type DiagnosticEntry } from '../../pwa/diagnostics'
import { importRound } from '../settle/exportRound'
import { LOCAL_USER } from '../../db/ids'
import { enqueuePushRound } from '../../remote/outbox'
import { useAuth } from '../../auth/AuthProvider'
import { AuthSheet } from '../auth/AuthSheet'
import { BigButton } from '../../components/BigButton'

export function DiagnosticsScreen() {
  const { activeUserId, isGuest, displayName, signOut } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState(false)
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
        <h1 className="font-display text-xs uppercase text-felt-300">Diagnostics</h1>
        <span className="w-12" />
      </header>

      <section className="pixel border-stone-700 bg-stone-900/70 p-4 text-lg">
        <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Account</h2>
        {isGuest ? (
          <>
            <p className="text-stone-400">Not signed in — your data lives only on this device.</p>
            <BigButton variant="outline" className="mt-3 w-full" onClick={() => setAuthOpen(true)}>
              Sign in
            </BigButton>
          </>
        ) : (
          <>
            <p>
              Signed in as <span className="text-felt-300">{displayName}</span>
            </p>
            <BigButton variant="outline" className="mt-3 w-full" onClick={() => void signOut()}>
              Sign out
            </BigButton>
          </>
        )}
      </section>

      <section className="pixel border-stone-700 bg-stone-900/70 p-4 text-lg">
        <p>
          Version <span className="font-mono text-felt-300">{__APP_VERSION__}</span>
        </p>
        <p className="mt-1">Storage: {storage ?? '—'}</p>
        <p className="mt-1">
          Persistent storage: {persisted === undefined ? '—' : persisted ? 'granted ✓' : 'not granted'}
        </p>
      </section>

      <section className="pixel border-stone-700 bg-stone-900/70 p-4">
        <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Data</h2>
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
              .then((text) => importRound(text, activeUserId))
              .then((round) => {
                setImportError(false)
                // a signed-in import of a completed round should sync too
                if (activeUserId !== LOCAL_USER && round.status === 'completed') {
                  void enqueuePushRound(activeUserId, round)
                }
              })
              .catch(() => setImportError(true))
            e.target.value = ''
          }}
        />
        <BigButton variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
          Import round from file
        </BigButton>
        <p className="mt-2 text-sm text-stone-500">Restore a round from an exported .json file.</p>
        {importError && (
          <p className="mt-2 text-sm text-flag-500">That file isn't a golf round export.</p>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-[10px] uppercase text-stone-400">
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
              <li key={i} className="pixel border-stone-700 bg-stone-900/70 p-3 text-sm">
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

      <AuthSheet open={authOpen} onClose={() => setAuthOpen(false)} />
    </main>
  )
}
