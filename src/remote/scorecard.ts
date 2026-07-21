import type { Course } from '../engine/core/types'
import { newId } from '../db/ids'
import { buildRemoteCourse } from './transform'
import { supabase } from './supabase'

/**
 * Scorecard-photo scan, via the `extract-scorecard` Edge Function (which holds
 * the Anthropic key and calls the vision API — see supabase/functions/
 * extract-scorecard). Online + signed-in only. Returns a draft Course the
 * caller pre-fills into the editor for the user to verify before saving; the
 * heavy normalization (dense stroke-index permutation, par clamp, hole
 * renumber, neutral-tee fallback) is done here by buildRemoteCourse.
 */

interface ScanDraft {
  name?: string
  location?: string | null
  holes?: { number: number; par: number; handicapIndex: number | null }[]
  teeSets?: {
    name: string
    color?: string | null
    rating?: number | null
    slope?: number | null
    yardages?: (number | null)[]
  }[]
}

function fileToImage(file: File): Promise<{ media_type: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('could not read image'))
    reader.onload = () => {
      const result = reader.result as string // "data:image/jpeg;base64,...."
      const comma = result.indexOf(',')
      resolve({
        media_type: file.type || 'image/jpeg',
        data: comma >= 0 ? result.slice(comma + 1) : result,
      })
    }
    reader.readAsDataURL(file)
  })
}

export async function scanScorecard(files: File[]): Promise<Course> {
  const chosen = files.slice(0, 2)
  if (chosen.length === 0) throw new Error('no image selected')
  const images = await Promise.all(chosen.map(fileToImage))

  const { data, error } = await supabase.functions.invoke<{ draft?: ScanDraft }>(
    'extract-scorecard',
    { body: { images } },
  )
  if (error) throw new Error(await extractError(error))

  const draft = data?.draft
  const holes = draft?.holes ?? []
  if (holes.length !== 9 && holes.length !== 18) {
    throw new Error("couldn't read a full 9- or 18-hole scorecard — add it manually instead")
  }

  const course = buildRemoteCourse({
    id: newId(),
    name: draft?.name?.trim() || '',
    // location is already "City, ST"; pass it as city so buildRemoteCourse
    // doesn't re-join it with a state.
    city: draft?.location ?? undefined,
    holes: holes.map((h) => ({ number: h.number, par: h.par, handicapIndex: h.handicapIndex })),
    tees: draft?.teeSets?.map((t) => ({
      name: t.name,
      color: t.color ?? undefined,
      rating: t.rating ?? undefined,
      slope: t.slope ?? undefined,
      yardages: t.yardages?.map((y) => y ?? undefined),
    })),
  })

  // A scanned course is user-authored — it publishes to the shared library on
  // save (buildRemoteCourse defaults source to 'remote'; the editor's save also
  // stamps 'user', but set it here so the draft is consistent).
  return { ...course, source: 'user' }
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
  return error instanceof Error ? error.message : 'scan failed'
}
