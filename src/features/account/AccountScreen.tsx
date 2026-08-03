import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import { AuthSheet } from '../auth/AuthSheet'
import { BigButton } from '../../components/BigButton'
import { Sheet } from '../../components/Sheet'

/**
 * Account home: who you're signed in as, sign out, and delete account.
 *
 * A screen of its own rather than a section of Diagnostics, because App Store
 * guideline 5.1.1(v) requires account deletion to be easy to FIND — buried
 * behind a ⚙ chip on a screen called "Diagnostics" is exactly the placement
 * that gets flagged. Diagnostics keeps storage stats, logs and import/export.
 */
export function AccountScreen() {
  const { isGuest, displayName, signOut, deleteAccount } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const onDelete = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await deleteAccount()
      setConfirmOpen(false) // AppLayout remounts to guest on the auth change
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete your account.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh flex-col gap-4 py-6">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-stone-400">
          ← Home
        </Link>
        <h1 className="font-display text-xs uppercase text-felt-300">Account</h1>
        <span className="w-12" />
      </header>

      <section className="pixel border-stone-700 bg-stone-900/70 p-4 text-lg">
        {isGuest ? (
          <>
            <p className="text-stone-400">
              Not signed in — your rounds live only on this device. Sign in to back them up and
              carry them to another phone.
            </p>
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

      {!isGuest && (
        <section className="pixel border-stone-700 bg-stone-900/70 p-4">
          <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Danger zone</h2>
          <p className="text-lg text-stone-400">
            Deleting your account signs you out and removes your synced rounds. Deletion finishes
            within 30 days.
          </p>
          <BigButton
            variant="danger"
            className="mt-3 w-full"
            onClick={() => {
              setError(undefined)
              setConfirmOpen(true)
            }}
          >
            Delete account
          </BigButton>
        </section>
      )}

      <section className="pixel mt-auto border-stone-700 bg-stone-900/70 p-4">
        <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Course data</h2>
        <p className="text-lg text-stone-400">
          Includes data from{' '}
          <a href="https://opengolfapi.org" className="text-felt-400 underline">
            OpenGolfAPI
          </a>
          , made available under the{' '}
          <a
            href="https://opendatacommons.org/licenses/odbl/1-0/"
            className="text-felt-400 underline"
          >
            Open Database License (ODbL)
          </a>
          .
        </p>
      </section>

      <Sheet open={confirmOpen} onClose={() => !busy && setConfirmOpen(false)}>
        <h2 className="font-display text-sm uppercase text-flag-500">Delete account?</h2>
        <p className="mt-3 text-lg text-stone-300">
          This deletes your account and every round synced to it. Rounds you tracked before signing
          in stay on this device.
        </p>
        {/* Apple 5.1.1(v) allows deletion that takes time, but requires telling
            the user how long. The "finished rounds" wording is load-bearing, not
            hedging: only completed rounds are ever pushed to the server, so a
            round still in progress has no backup and cannot be reinstated. */}
        <p className="mt-2 text-lg text-stone-400">
          You can sign up again with the same email straight away. Deletion completes within 30
          days — if it was a mistake, contact support before then and your finished rounds may be
          recoverable. A round still in progress can’t be.
        </p>
        {error && <p className="mt-3 text-lg text-flag-500">{error}</p>}
        <div className="mt-5 flex flex-col gap-2">
          <BigButton variant="danger" disabled={busy} onClick={() => void onDelete()}>
            {busy ? 'Deleting…' : 'Yes, delete everything'}
          </BigButton>
          <BigButton variant="ghost" disabled={busy} onClick={() => setConfirmOpen(false)}>
            Cancel
          </BigButton>
        </div>
      </Sheet>

      <AuthSheet open={authOpen} onClose={() => setAuthOpen(false)} />
    </main>
  )
}
