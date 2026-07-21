import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './routes'
import { pruneSeededCourses } from '../db/seed'
import { ensurePersistentStorage, initDiagnostics } from '../pwa/diagnostics'
import { registerOutboxFlush } from '../remote/outbox'
import '../engine/games'
import './index.css'

initDiagnostics()
void pruneSeededCourses()
void ensurePersistentStorage()
registerOutboxFlush()

const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL.replace(/\/$/, ''),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
