// Thread pop-out — open the active thread in a small always-available
// companion window (Codex-style floating thread). The Rust side owns window
// creation (open_thread_window command); the new window boots the same SPA
// with ?popout={sessionId} and renders PopoutThreadRoot.

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './pty'

/** Session id when this window is a pop-out (parsed once at module load). */
export function popoutSessionId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('popout')
  } catch {
    return null
  }
}

/** Open (or focus) the pop-out window for a session. No-op outside Tauri. */
export async function openThreadPopout(sessionId: string): Promise<void> {
  if (!isTauri()) return
  await invoke('open_thread_window', { sessionId })
}
