import { useState } from 'react'

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true)
  )
}

const DISMISS_KEY = 'golf-install-hint-dismissed'

/**
 * iOS Safari has no install prompt API — and home-screen installs are what
 * shield IndexedDB from the 7-day eviction rule. So we nudge, once.
 */
export function InstallHint() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')
  if (dismissed || !isIOS() || isStandalone()) return null

  return (
    <div className="rounded-2xl bg-felt-900/60 p-4 text-sm ring-1 ring-felt-700">
      <div className="flex items-start justify-between gap-3">
        <p>
          <span className="font-semibold">Install for the course:</span> tap{' '}
          <span className="font-semibold">Share</span> <span aria-hidden>⎋</span> then{' '}
          <span className="font-semibold">Add to Home Screen</span>. Works fully offline, and your
          rounds are protected.
        </p>
        <button
          aria-label="dismiss"
          className="text-stone-400"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, '1')
            setDismissed(true)
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
