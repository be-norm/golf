import { useEffect, useState } from 'react'
import { Sheet } from '../../components/Sheet'
import { BigButton } from '../../components/BigButton'
import { useAuth } from '../../auth/AuthProvider'
import { claimLocalData, countLocalGuestData } from '../../remote/sync'

/**
 * On sign-in, offer to move any signed-out ("guest") rounds + roster on this
 * device into the account. Strictly opt-in (a friend signing in on your phone
 * must not silently absorb your data), and dismissable per session.
 */
export function ClaimPrompt() {
  const { activeUserId, isGuest } = useAuth()
  const [handledFor, setHandledFor] = useState<string | null>(null)
  const [counts, setCounts] = useState<{ rounds: number; players: number } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (isGuest || activeUserId === handledFor) return
    let active = true
    void countLocalGuestData().then((c) => {
      if (active) setCounts(c)
    })
    return () => {
      active = false
    }
  }, [isGuest, activeUserId, handledFor])

  // Gate on the guard too, so stale counts from a prior identity never re-open
  // the sheet after sign-out or once this user has handled it.
  const open =
    !isGuest &&
    activeUserId !== handledFor &&
    counts !== null &&
    counts.rounds + counts.players > 0

  const dismiss = () => {
    setHandledFor(activeUserId)
    setCounts(null)
  }

  const claim = async () => {
    setBusy(true)
    try {
      await claimLocalData(activeUserId)
      dismiss()
    } catch {
      setBusy(false) // let them retry rather than hang on a stuck spinner
    }
  }

  const r = counts?.rounds ?? 0
  const p = counts?.players ?? 0

  return (
    <Sheet open={open} onClose={dismiss}>
      <h2 className="font-display text-sm uppercase text-felt-300">Add local data?</h2>
      <p className="mt-2 text-lg text-stone-200">
        You have {r} round{r === 1 ? '' : 's'} and {p} player{p === 1 ? '' : 's'} saved on this
        device. Add them to your account so they sync everywhere?
      </p>
      <div className="mt-5 space-y-2">
        <BigButton className="w-full" disabled={busy} onClick={() => void claim()}>
          Add to account
        </BigButton>
        <BigButton variant="ghost" className="w-full" disabled={busy} onClick={dismiss}>
          Not now
        </BigButton>
      </div>
    </Sheet>
  )
}
