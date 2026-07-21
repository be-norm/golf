import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import { scanScorecard } from '../../remote/scorecard'
import { AuthSheet } from '../auth/AuthSheet'

/**
 * "Scan scorecard" entry point: take/upload 1–2 photos of a scorecard, extract
 * a draft course via the vision Edge Function, and open the editor pre-filled
 * for review. Scanning spends money server-side, so it's signed-in only —
 * guests are shown the sign-in sheet instead (manual entry stays available).
 */
export function ScanButton({ className = '' }: { className?: string }) {
  const { isGuest } = useAuth()
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [authOpen, setAuthOpen] = useState(false)

  const onClick = () => {
    setError(undefined)
    if (isGuest) setAuthOpen(true)
    else input.current?.click()
  }

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      const draft = await scanScorecard(Array.from(files))
      navigate('/courses/new', { state: { draft } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'scan failed')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = '' // allow re-picking the same file
    }
  }

  return (
    <div>
      <button
        onClick={onClick}
        disabled={busy}
        className={`pixel-press font-display block w-full border-felt-600 bg-felt-900/60 px-4 py-4 text-center text-xs uppercase disabled:opacity-50 ${className}`}
      >
        {busy ? 'Reading scorecard…' : '📷 Scan scorecard'}
      </button>
      {error && <p className="mt-2 text-sm text-flag-500">{error}</p>}
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />
      <AuthSheet open={authOpen} onClose={() => setAuthOpen(false)} />
    </div>
  )
}
