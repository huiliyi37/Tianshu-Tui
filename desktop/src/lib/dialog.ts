// Native folder picker (P1). Uses the Tauri dialog plugin when running inside the
// desktop shell; in a plain browser dev context (or before the Rust plugin is
// wired) the call rejects and we return null so callers fall back to a text input.

import { open } from '@tauri-apps/plugin-dialog'

/** True when running inside the Tauri shell (so a native picker is available). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export async function pickFolder(): Promise<string | null> {
  try {
    const res = await open({ directory: true, multiple: false })
    return typeof res === 'string' ? res : null
  } catch {
    // Not in Tauri, plugin/capability not yet wired, or user cancelled.
    return null
  }
}
