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
