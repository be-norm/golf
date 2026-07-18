import { useState } from 'react'

/** Test stub for virtual:pwa-register/react — no service worker in jsdom. */
export function useRegisterSW() {
  const needRefresh = useState(false)
  const offlineReady = useState(false)
  return {
    needRefresh,
    offlineReady,
    updateServiceWorker: async () => {},
  }
}
