import { Outlet } from 'react-router'
import { UpdateToast } from '../pwa/UpdateToast'

export function AppLayout() {
  return (
    <div className="min-h-dvh bg-felt-950 text-stone-100 antialiased">
      <div className="mx-auto min-h-dvh max-w-md px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <Outlet />
      </div>
      <UpdateToast />
    </div>
  )
}
