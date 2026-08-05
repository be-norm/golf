/**
 * Repos enqueue sync ops by writing `outbox` rows inside their own Dexie
 * transactions — atomic with the data they describe, which is what makes
 * "membership and its push cannot drift" true rather than aspirational
 * (MAI-76). But the flusher lives in the remote layer, whose module graph
 * creates the Supabase client at import time. This one-function seam lets the
 * db layer kick a flush without importing the network stack; until the app
 * registers a notifier (registerOutboxFlush), it is a no-op, which is exactly
 * right for unit tests that drive the flush themselves.
 */
let notify: () => void = () => {}

export function setOutboxNotifier(fn: () => void): void {
  notify = fn
}

/** Call after committing a transaction that wrote outbox rows. */
export function notifyOutboxWrite(): void {
  notify()
}
