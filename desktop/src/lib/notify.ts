import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import type { NotifPref } from './persist'

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
 * Check whether the notification should fire given the user's preference and
 * current window focus state. 'never' blocks all; 'background' blocks when the
 * window is focused (no nag during active use); 'always' fires regardless.
 */
export function shouldNotify(pref: NotifPref): boolean {
  if (pref === 'never') return false
  if (pref === 'always') return true
  // 'background' — fire only when the window is NOT focused
  if (typeof document !== 'undefined' && document.hasFocus()) return false
  return true
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

/** Like notify(), but tags the notification so a click can jump to `sessionId`.
 *  Pass the user's notification preference to gate firing. */
export async function notifyRouted(
  title: string,
  body: string,
  sessionId: string,
  pref: NotifPref = 'background',
): Promise<void> {
  if (!shouldNotify(pref)) return
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
