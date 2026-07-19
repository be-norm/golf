import { Outlet } from 'react-router'
import { UpdateToast } from '../pwa/UpdateToast'

export function AppLayout() {
  return (
    <div className="min-h-dvh bg-felt-950 text-stone-100 antialiased">
      <div className="mx-auto min-h-dvh max-w-md px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <Outlet />
      </div>
      {/* CRT scanline overlay — purely decorative, faint */}
      <div aria-hidden className="scanlines pointer-events-none fixed inset-0 z-[70] opacity-[0.13]" />
      <UpdateToast />
    </div>
  )
}
