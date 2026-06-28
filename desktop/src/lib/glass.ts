// Glass-mode preference: enables translucent surfaces + backdrop blur even when
// no custom wallpaper is set. Stored in localStorage and broadcast via a custom
// event so consumers can react without a full context provider.

import { resolveTheme, loadThemePref } from './theme'
import { applyThemeJson } from './theme-loader'

const KEY = 'tianshu.glassMode'
const CHANGE_EVENT = 'tianshu:glasschange'

export type GlassMode = boolean

export function loadGlassMode(): GlassMode {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function saveGlassMode(value: GlassMode): void {
  try {
    localStorage.setItem(KEY, value ? '1' : '0')
    window.dispatchEvent(new Event(CHANGE_EVENT))
  } catch {
    // non-fatal
  }
}

/**
 * Update visual glass state. Sets/removes data-surface attribute (for
 * shadcn-tokens.css + styles.css selectors) AND re-applies theme surface
 * tokens (glass vs solid) via setProperty.
 *
 * Called by: the settings toggle, initGlassMode, AND WallpaperLayer
 * (when a custom wallpaper is set, glass surfaces should activate regardless
 * of the persisted glassMode preference).
 */
export function applyGlassMode(value: GlassMode): void {
  const root = document.documentElement
  if (value) root.setAttribute('data-surface', 'glass')
  else root.removeAttribute('data-surface')
  // Sync surface tokens with visual glass state
  applyThemeJson(resolveTheme(loadThemePref()), value)
  // Sync the native window backdrop (Windows Mica) with the preference so it
  // only composites when glass is actually on — otherwise it's wasted DWM work
  // behind opaque CSS. No-op on macOS (command is cfg-gated) and in browser/tests.
  void import('@tauri-apps/api/core')
    .then((m) => m.invoke('set_window_glass', { enabled: value }))
    .catch(() => { /* not running under Tauri */ })
}

export function initGlassMode(): void {
  applyGlassMode(loadGlassMode())
}

import { useEffect, useState } from 'react'

/** React hook that syncs with the persisted glass mode and broadcasts changes. */
export function useGlassMode(): [GlassMode, (value: GlassMode) => void] {
  const [enabled, setEnabled] = useState(loadGlassMode)

  useEffect(() => {
    const onChange = () => setEnabled(loadGlassMode())
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [])

  return [
    enabled,
    (value) => {
      saveGlassMode(value)
      setEnabled(value)
      applyGlassMode(value)
    },
  ]
}
