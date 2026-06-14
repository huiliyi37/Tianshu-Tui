// Reconnect-on-reload: remember which session the user was looking at so a app
// reload (or sidecar restart) lands back where they were. The event stream
// rebuilds full history from since=0, so only the active id needs persisting.

const KEY_ACTIVE = 'tianshu.activeSessionId'

export function loadActiveSessionId(): string | null {
  try {
    return localStorage.getItem(KEY_ACTIVE)
  } catch {
    return null
  }
}

export function saveActiveSessionId(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY_ACTIVE, id)
    else localStorage.removeItem(KEY_ACTIVE)
  } catch {
    // private mode / disabled storage — non-fatal
  }
}
