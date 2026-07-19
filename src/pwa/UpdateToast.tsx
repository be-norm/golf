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
    <div className="pixel fixed inset-x-4 bottom-4 z-50 flex items-center justify-between gap-3 border-felt-500 bg-stone-900 p-4">
      <span className="text-lg">
        <span className="animate-blink text-coin-400">▶</span> Update available
      </span>
      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 text-lg text-stone-400"
          onClick={() => setNeedRefresh(false)}
        >
          Later
        </button>
        <button
          className="pixel-press border-felt-300 bg-felt-600 px-3 py-1.5 text-lg"
          onClick={() => {
            void updateServiceWorker(true).then(() => {
              // belt & suspenders: if the SW swap didn't reload the page
              // (older installs, activation races), force it once the
              // fresh worker has had a beat to claim the client
              setTimeout(() => window.location.reload(), 800)
            })
          }}
        >
          Reload
        </button>
      </div>
    </div>
  )
}
