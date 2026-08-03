import { supabase } from './supabase'
import { wipeUserData } from '../db/wipe'

/**
 * Delete the signed-in user's account, everywhere.
 *
 * Server side, the `delete-account` Edge Function deletes the auth user with the
 * service-role key; `round_archives`, `players` and `scan_usage` all cascade from
 * it, while published courses survive with `created_by` nulled. Locally we then
 * drop this device's copy of that user's data and sign out.
 *
 * Ordering matters: remote first. If the local wipe ran first and the network
 * call then failed, the user would be left signed in to an account whose data we
 * had already destroyed. Deleting remotely first means a mid-flight failure
 * leaves the local copy intact and the operation safely retryable.
 *
 * Sign-out is in a `finally` for the mirror-image reason. Once the remote delete
 * succeeds the account is gone, but the access token is a stateless JWT that
 * stays valid until it expires — so if the local wipe threw and took sign-out
 * with it, the app would sit there apparently signed in to an account that no
 * longer exists. Better to end up signed out with some stale local rows (which
 * are invisible: guest queries are scoped to LOCAL_USER) than signed in to
 * nothing.
 *
 * Online-only by nature — there is no honest way to queue "delete my account"
 * for later, because the user is entitled to know it actually happened.
 */
export async function deleteAccount(userId: string): Promise<void> {
  if (!navigator.onLine) {
    throw new Error('Deleting your account needs a connection. Try again when you’re online.')
  }

  const { error } = await supabase.functions.invoke('delete-account', { body: {} })
  if (error) {
    throw new Error('Could not delete your account. Nothing was changed — please try again.')
  }

  try {
    await wipeUserData(userId)
  } finally {
    await supabase.auth.signOut()
  }
}
