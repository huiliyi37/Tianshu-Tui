import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

let permission: Promise<boolean> | null = null

async function ensurePermission(): Promise<boolean> {
  if (!permission) {
    permission = (async () => {
      try {
        let granted = await isPermissionGranted()
        if (!granted) granted = (await requestPermission()) === 'granted'
        return granted
      } catch {
        return false
      }
    })()
  }
  return permission
}

/**
 * Fire an async OS notification — only when the window is NOT focused, so we
 * never nag during active use. No-ops gracefully outside Tauri (browser dev).
 */
export async function notify(title: string, body: string): Promise<void> {
  if (typeof document !== 'undefined' && document.hasFocus()) return
  try {
    if (await ensurePermission()) sendNotification({ title, body })
  } catch {
    // not running under Tauri, or permission denied — silent
  }
}

// ── S: routed notifications (click → focus window + jump to session) ──
// Tauri's notification click delivery varies by version/OS, so this is strictly
// best-effort: we correlate a generated id → sessionId, register one action
// listener, and on activation focus the window and invoke the navigate cb. If
// the plugin doesn't surface clicks, the deterministic copy still shows.

let routeInit = false
const idToSession = new Map<number, string>()
let nextId = 1

/** Wire the global click router once. `onPick(sessionId)` should navigate. */
export function initNotificationRouting(onPick: (sessionId: string) => void): void {
  if (routeInit) return
  routeInit = true
  void (async () => {
    try {
      const mod = (await import('@tauri-apps/plugin-notification')) as unknown as {
        onAction?: (cb: (n: { id?: number }) => void) => Promise<unknown>
      }
      if (typeof mod.onAction !== 'function') return
      await mod.onAction(async (n) => {
        const sid = n?.id != null ? idToSession.get(n.id) : undefined
        if (!sid) return
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          await getCurrentWindow().setFocus()
        } catch { /* not under Tauri */ }
        onPick(sid)
      })
    } catch {
      // plugin shape unavailable — clicks just won't route
    }
  })()
}

/** Like notify(), but tags the notification so a click can jump to `sessionId`. */
export async function notifyRouted(title: string, body: string, sessionId: string): Promise<void> {
  if (typeof document !== 'undefined' && document.hasFocus()) return
  try {
    if (!(await ensurePermission())) return
    const id = nextId++
    idToSession.set(id, sessionId)
    if (idToSession.size > 200) idToSession.delete(idToSession.keys().next().value as number)
    sendNotification({ id, title, body })
  } catch {
    // silent
  }
}
