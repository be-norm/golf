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

  await wipeUserData(userId)
  await supabase.auth.signOut()
}
