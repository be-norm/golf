import { Outlet } from 'react-router'
import { MotionConfig } from 'motion/react'
import { UpdateToast } from '../pwa/UpdateToast'
import { AuthProvider, useAuth } from '../auth/AuthProvider'
import { ClaimPrompt } from '../features/auth/ClaimPrompt'

/** Session-aware column. Gates on the initial getSession() so a signed-in user
 *  never flashes the guest home; the `key` remounts the screen on sign-in/out
 *  so every query re-reads under the new owner. */
function RoutedColumn() {
  const { activeUserId, loading } = useAuth()
  return (
    <div className="mx-auto min-h-dvh max-w-md px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {loading ? (
        <BootSplash />
      ) : (
        <div key={activeUserId}>
          <Outlet />
        </div>
      )}
    </div>
  )
}

function BootSplash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3">
      <img
        src={`${import.meta.env.BASE_URL}pwa-192x192.png`}
        alt=""
        className="size-16 [image-rendering:pixelated]"
      />
      <p className="font-display animate-blink text-[10px] uppercase text-felt-400">Loading…</p>
    </div>
  )
}

/**
 * `reducedMotion="user"` is the ONE line that covers every Motion call site in
 * the app at once — the sheet slide, the hole-number crossfade, the score-tile
 * tap, the settle confetti and every celebration. Motion drops transform and
 * layout animations and keeps opacity, which is exactly the right trade: the
 * information still arrives, the movement doesn't.
 *
 * It does NOT reach the CSS keyframes (`animate-blink`, `animate-stamp`, the
 * sprite strips) — those are handled by the `prefers-reduced-motion` block in
 * `index.css`. Both halves are required; neither is sufficient.
 */
export function AppLayout() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <div className="min-h-dvh bg-felt-950 text-stone-100 antialiased">
          <RoutedColumn />
          {/* CRT scanline overlay — purely decorative, faint */}
          <div aria-hidden className="scanlines pointer-events-none fixed inset-0 z-[70] opacity-[0.13]" />
          <UpdateToast />
          <ClaimPrompt />
        </div>
      </AuthProvider>
    </MotionConfig>
  )
}
