/**
 * Timestamps in this app cross two encodings: locally-minted stamps end `Z`
 * (`new Date().toISOString()`), Postgres returns `+00:00`. The SAME instant
 * must compare equal, so every LWW decision compares instants — never strings;
 * string order across the two encodings is meaningless.
 *
 * (supabase/functions/delete-account/index.ts keeps its own inline copy of
 * this rule — Deno can't import src/ — keep the two in step.)
 */
export const epoch = (iso: string): number => Date.parse(iso)
