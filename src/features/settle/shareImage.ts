import type { Round } from '../../engine/core/types'

/**
 * Getting a file off the phone: the share sheet where it exists, a download
 * everywhere else. This module is the ONLY place that touches the Web Share
 * API, so swapping in `@capacitor/share` for the native shell is a one-file
 * change (see docs/native-app-plan.md).
 */

/** `golf-Pebble-Creek-2026-08-03` — the stem for both the .png and the .json. */
export function roundFileBase(round: Round): string {
  return `golf-${round.courseSnapshot.name.replace(/\W+/g, '-')}-${round.startedAt.slice(0, 10)}`
}

/**
 * Sharing files needs both the API and a secure context, so plain-http origins
 * (a LAN IP in dev) report false and fall through to the download path.
 */
export function canShareFile(file: File): boolean {
  try {
    return navigator.canShare?.({ files: [file] }) ?? false
  } catch {
    return false
  }
}

export type ShareResult = 'shared' | 'cancelled' | 'failed'

export async function shareFile(file: File, title: string): Promise<ShareResult> {
  try {
    await navigator.share({ files: [file], title })
    return 'shared'
  } catch (err) {
    // dismissing the sheet rejects with AbortError — that's a choice, not a fault
    return err instanceof Error && err.name === 'AbortError' ? 'cancelled' : 'failed'
  }
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  URL.revokeObjectURL(url)
}
