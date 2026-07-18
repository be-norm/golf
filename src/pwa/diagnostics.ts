/**
 * Local-only failure visibility for an offline app: a localStorage ring buffer
 * (deliberately not Dexie — must survive DB corruption) capturing runtime
 * errors, viewable under /diagnostics and included in nothing by default.
 */

const KEY = 'golf-error-log'
const MAX = 50

export interface DiagnosticEntry {
  at: string
  message: string
  stack?: string
}

export function readErrorLog(): DiagnosticEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as DiagnosticEntry[]
  } catch {
    return []
  }
}

export function clearErrorLog(): void {
  localStorage.removeItem(KEY)
}

function record(message: string, stack?: string): void {
  try {
    const log = readErrorLog()
    log.push({ at: new Date().toISOString(), message: message.slice(0, 500), stack: stack?.slice(0, 2000) })
    localStorage.setItem(KEY, JSON.stringify(log.slice(-MAX)))
  } catch {
    // diagnostics must never break the app
  }
}

export function initDiagnostics(): void {
  window.addEventListener('error', (e) => {
    record(String(e.message), e.error instanceof Error ? e.error.stack : undefined)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason
    record(
      reason instanceof Error ? reason.message : `unhandled rejection: ${String(reason)}`,
      reason instanceof Error ? reason.stack : undefined,
    )
  })
}

/** Ask the browser to protect our storage from eviction; report the result. */
export async function ensurePersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
