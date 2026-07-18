import { useRegisterSW } from 'virtual:pwa-register/react'

export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

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
