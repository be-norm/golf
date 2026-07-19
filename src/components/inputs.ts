import type React from 'react'

/** Tapping a numeric field selects its contents so typing replaces, not appends. */
export function selectOnFocus(e: React.FocusEvent<HTMLInputElement>): void {
  e.currentTarget.select()
}
