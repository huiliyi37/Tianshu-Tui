import i18n from '../i18n'

/**
 * Open an external URL in the system default browser.
 *
 * Why this exists: the Tauri v2 webview silently intercepts `window.open`,
 * so a plain `window.open(url, '_blank')` does nothing on click. The official
 * fix is the opener plugin's `openUrl()`, which routes through the OS.
 *
 * The plugin is dynamically imported so non-Tauri contexts (jsdom tests, vite
 * dev in a browser) fall back to `window.open` without crashing on a missing
 * module. A thrown error in the plugin (e.g. permission denied) also falls
 * back rather than leaving the click silently dead.
 */
export function openExternal(href: string): void {
  void import('@tauri-apps/plugin-opener')
    .then((m) => m.openUrl(href))
    .catch(() => {
      // Not under Tauri, or opener unavailable: fall back to window.open.
      try { window.open(href, '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
    })
}

/**
 * Open the RIVET_HOME data directory in the system file explorer.
 *
 * Resolves the runtime data root (sessions, config, cache logs) from
 * `runtime_info` and opens it with the OS default file manager. Falls
 * back to showing an alert with the path when the opener plugin is
 * unavailable (e.g. browser dev mode).
 */
export async function openRivetHome(): Promise<void> {
  let rivetHome: string | undefined
  try {
    // Dynamic import to avoid bundling the runtime client in non-Tauri contexts.
    const { getRuntimeInfo } = await import('../runtime/client.js')
    const info = await getRuntimeInfo()
    rivetHome = info.rivetHome
  } catch {
    // getRuntimeInfo or runtime_info command failed — try RIVET_HOME env.
    rivetHome = ((import.meta as unknown as Record<string, unknown>).env as Record<string, string> | undefined)?.['VITE_RIVET_HOME']
  }

  if (!rivetHome) {
    alert(i18n.t('shell:dataDir.unavailable'))
    return
  }

  try {
    const opener = await import('@tauri-apps/plugin-opener')
    await opener.openPath(rivetHome)
  } catch {
    // Not under Tauri — fall back to showing the path.
    alert(i18n.t('shell:dataDir.location', { path: rivetHome }))
  }
}
