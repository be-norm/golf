import { createClient } from '@supabase/supabase-js'

/**
 * Anon-key client. RLS enforces owner-scoping once signed in (courses stay
 * publicly readable). Auth options make it a good PWA citizen:
 * - persistSession + autoRefreshToken: survive relaunches, refresh when online.
 * - detectSessionInUrl + flowType 'pkce': complete the Google OAuth `?code=`
 *   redirect client-side under the /golf/ base (the SW serves index.html).
 */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  },
)
