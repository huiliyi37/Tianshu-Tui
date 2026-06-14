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
