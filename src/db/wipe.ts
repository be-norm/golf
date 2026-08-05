import { db as defaultDb, type GolfDB } from './schema'

/**
 * Remove every local row owned by one user, in a single transaction.
 *
 * Used after account deletion: the server drops the auth user (and everything
 * cascading from it), and this drops the mirror on this device so the app can't
 * keep showing rounds for an account that no longer exists.
 *
 * Deliberately scoped by owner rather than clearing the database:
 * - guest rows (`LOCAL_USER`) survive — they were never part of the account, and
 *   a user who deletes their account still owns whatever they tracked signed-out;
 * - the course CARDS in `courses` survive — that table is the shared library,
 *   matching the server, where `courses.created_by` is `on delete set null`
 *   rather than cascading. But this user's MEMBERSHIP in it does not: their
 *   saved library is owned data that cascades away server-side, so leaving it
 *   here would show a deleted account's courses to whoever signs in next — and
 *   push them into that account (MAI-76);
 * - queued outbox ops for this user are dropped, since pushing them to a deleted
 *   account would fail forever and block the queue behind them.
 */
export async function wipeUserData(userId: string, db: GolfDB = defaultDb): Promise<void> {
  await db.transaction(
    'rw',
    db.rounds,
    db.round_events,
    db.players,
    db.outbox,
    db.saved_courses,
    async () => {
      const roundIds = await db.rounds.where('userId').equals(userId).primaryKeys()
      for (const id of roundIds) {
        await db.round_events.where('roundId').equals(id).delete()
      }
      await db.rounds.bulkDelete(roundIds)
      await db.players.where('userId').equals(userId).delete()
      // membership only — the shared cards stay, see the note above
      await db.saved_courses.where('userId').equals(userId).delete()

      // Payload shape varies by kind, but every one carries `userId`.
      const stale = await db.outbox
        .filter((item) => (item.payload as { userId?: string })?.userId === userId)
        .primaryKeys()
      await db.outbox.bulkDelete(stale)
    },
  )
}
