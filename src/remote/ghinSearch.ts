import { supabase } from './supabase'

/**
 * GHIN golfer lookup, via the `ghin-search` Edge Function (which holds the GHIN
 * login and proxies api2.ghin.com — see supabase/functions/ghin-search). Online
 * + signed-in only; unlike course search this surfaces errors, because the user
 * explicitly triggered it and needs to know why nothing came back.
 */

export interface GhinPlayerHit {
  ghinNumber: string
  firstName: string
  lastName: string
  fullName: string
  /** numeric Handicap Index, or null for "NH" (no established index) */
  handicapIndex: number | null
  handicapDisplay: string
  clubName: string | null
  associationName: string | null
  state: string | null
  status: string | null
}

/**
 * Split a free-text name box into GHIN's last/first search fields:
 * "Rob Smith" → {first:'Rob', last:'Smith'}; "Smith" → {last:'Smith'};
 * "Smith, Rob" → {first:'Rob', last:'Smith'}. GHIN keys search on last name.
 */
export function parseName(query: string): { firstName?: string; lastName?: string } {
  const q = query.trim()
  if (!q) return {}
  if (q.includes(',')) {
    const idx = q.indexOf(',')
    const last = q.slice(0, idx).trim()
    const first = q.slice(idx + 1).trim()
    return { lastName: last || undefined, firstName: first || undefined }
  }
  const parts = q.split(/\s+/)
  const lastName = parts[parts.length - 1] ?? q
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined
  return { lastName, firstName }
}

export async function searchGhinPlayers(query: string, state?: string): Promise<GhinPlayerHit[]> {
  const { lastName, firstName } = parseName(query)
  if (!lastName || lastName.length < 2) return []
  const st = state?.trim().toUpperCase()
  const { data, error } = await supabase.functions.invoke<{ golfers?: GhinPlayerHit[] }>(
    'ghin-search',
    { body: { lastName, firstName, state: st && st.length === 2 ? st : undefined } },
  )
  if (error) throw new Error(await extractError(error))
  return data?.golfers ?? []
}

/**
 * Re-fetch a single golfer by GHIN number (for "refresh handicap"). Returns the
 * current record, or null if GHIN no longer has that number.
 */
export async function refreshGhinPlayer(ghinNumber: string): Promise<GhinPlayerHit | null> {
  const { data, error } = await supabase.functions.invoke<{ golfers?: GhinPlayerHit[] }>(
    'ghin-search',
    { body: { ghinNumber } },
  )
  if (error) throw new Error(await extractError(error))
  return data?.golfers?.[0] ?? null
}

/** supabase-js FunctionsHttpError carries the function's Response on `.context`. */
async function extractError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = (await ctx.json()) as { error?: string }
      if (body?.error) return body.error
    } catch {
      /* fall through to the generic message */
    }
  }
  return error instanceof Error ? error.message : 'GHIN search failed'
}
