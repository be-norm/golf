import { createClient } from '@supabase/supabase-js'

/** Anon-key client; RLS enforces read-published-courses + insert-only archives. */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
)
