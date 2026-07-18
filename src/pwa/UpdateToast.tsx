import { useRegisterSW } from 'virtual:pwa-register/react'
import { useLiveQuery } from 'dexie-react-hooks'
import { roundRepo } from '../db/repos'

export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return
      // installed-for-weeks phones learn about updates when brought to foreground
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update()
      })
    },
  })

  // never interrupt a live round with an update prompt — the toast simply
  // stays hidden until the round completes (needRefresh remains latched)
  const liveRound = useLiveQuery(() => roundRepo.liveRound())
  if (!needRefresh || liveRound) return null

  return (
    <div className="fixed inset-x-4 bottom-4 z-50 flex items-center justify-between gap-3 rounded-2xl bg-stone-900 p-4 shadow-xl ring-1 ring-stone-700">
      <span className="text-sm">Update available</span>
      <div className="flex gap-2">
        <button
          className="rounded-lg px-3 py-1.5 text-sm text-stone-400"
          onClick={() => setNeedRefresh(false)}
        >
          Later
        </button>
        <button
          className="rounded-lg bg-felt-600 px-3 py-1.5 text-sm font-semibold"
          onClick={() => void updateServiceWorker(true)}
        >
          Reload
        </button>
      </div>
    </div>
  )
}
