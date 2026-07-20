import { useState, type FormEvent } from 'react'
import { Sheet } from '../../components/Sheet'
import { BigButton } from '../../components/BigButton'
import { useAuth } from '../../auth/AuthProvider'

const INPUT =
  'min-h-12 w-full bg-stone-900 px-4 ring-1 ring-stone-700 placeholder:text-stone-500 focus:outline-none focus:ring-felt-500'

// Google sign-in stays hidden until the OAuth client is configured. Flip it on
// later with VITE_GOOGLE_AUTH=true in .env — no code change, just a rebuild.
const GOOGLE_ENABLED = import.meta.env.VITE_GOOGLE_AUTH === 'true'

export function AuthSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { signInWithPassword, signUpWithPassword, signInWithGoogle } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const close = () => {
    setError(null)
    setPassword('')
    setSentTo(null)
    onClose()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const trimmed = email.trim()
    if (mode === 'signup') {
      const { error, needsConfirmation } = await signUpWithPassword(trimmed, password)
      setBusy(false)
      if (error) setError(error)
      else if (needsConfirmation) setSentTo(trimmed) // confirmation on → check email
      else close() // confirmation off → already signed in
      return
    }
    const { error } = await signInWithPassword(trimmed, password)
    setBusy(false)
    if (error) setError(error)
    else close()
  }

  const google = async () => {
    setBusy(true)
    setError(null)
    const { error } = await signInWithGoogle()
    // on success the browser redirects to Google; only errors return here
    if (error) {
      setError(error)
      setBusy(false)
    }
  }

  if (sentTo) {
    return (
      <Sheet open={open} onClose={close}>
        <h2 className="font-display text-sm uppercase text-felt-300">Check your email</h2>
        <p className="mt-2 text-lg text-stone-200">
          We sent a confirmation link to <span className="text-felt-300">{sentTo}</span>. Open it in
          this browser to finish — you'll be signed in automatically.
        </p>
        <BigButton className="mt-5 w-full" onClick={close}>
          Got it
        </BigButton>
      </Sheet>
    )
  }

  return (
    <Sheet open={open} onClose={close}>
      <h2 className="font-display text-sm uppercase text-felt-300">
        {mode === 'signin' ? 'Sign in' : 'Create account'}
      </h2>
      <p className="mt-1 text-sm text-stone-400">Sync your rounds and roster across devices.</p>

      <form onSubmit={submit} className="mt-4 space-y-3">
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className={INPUT}
        />
        <input
          type="password"
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (6+ characters)"
          className={INPUT}
        />
        {error && <p className="text-sm text-flag-500">{error}</p>}
        <BigButton type="submit" className="w-full" disabled={busy}>
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </BigButton>
      </form>

      <button
        type="button"
        className="mt-3 text-sm text-felt-400"
        onClick={() => {
          setMode(mode === 'signin' ? 'signup' : 'signin')
          setError(null)
        }}
      >
        {mode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in'}
      </button>

      {GOOGLE_ENABLED && (
        <>
          <div className="my-4 flex items-center gap-3 text-xs uppercase text-stone-600">
            <span className="h-px flex-1 bg-stone-700" /> or{' '}
            <span className="h-px flex-1 bg-stone-700" />
          </div>
          <BigButton
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => void google()}
          >
            Continue with Google
          </BigButton>
        </>
      )}
    </Sheet>
  )
}
