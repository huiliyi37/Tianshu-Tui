// Theme preference (P0). system|light|dark, persisted to localStorage and applied
// as [data-theme] on <html> + CSS variables via setProperty (JSON-driven).
// `system` follows prefers-color-scheme live.

import { applyThemeJson } from './theme-loader'

export type ThemePref = 'system' | 'light' | 'dark' | 'nebula' | 'sakura' | 'cyberpunk' | 'cupertino'
export type ResolvedTheme = 'light' | 'dark' | 'nebula' | 'sakura' | 'cyberpunk' | 'cupertino'

const KEY = 'tianshu.theme'

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system' || v === 'nebula' || v === 'sakura' || v === 'cyberpunk' || v === 'cupertino') return v
  } catch {
    // disabled storage — fall through
  }
  return 'dark'
}

export function saveThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    // non-fatal
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return pref
}

/**
 * Apply theme + surface tokens via setProperty (JSON-driven).
 * `glass` controls whether glass-mode surface tokens are written.
 */
export function applyTheme(pref: ThemePref, glass: boolean): void {
  const resolved = resolveTheme(pref)
  applyThemeJson(resolved, glass)
}

/**
 * Apply the saved preference and keep it in sync with the OS when set to
 * `system`. Returns a disposer (rarely needed — the app lives for the session).
 */
export function initTheme(): () => void {
  const pref = loadThemePref()
  applyTheme(pref, loadGlassModeFromStorage())

  let media: MediaQueryList | null = null
  const onChange = () => {
    if (loadThemePref() === 'system') applyTheme('system', loadGlassModeFromStorage())
  }
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', onChange)
  } catch {
    media = null
  }
  return () => media?.removeEventListener('change', onChange)
}

/** Set + persist + apply in one call (used by Settings). */
export function setThemePref(pref: ThemePref): void {
  saveThemePref(pref)
  applyTheme(pref, loadGlassModeFromStorage())
}

/** Read glass-mode preference directly from localStorage (avoids circular import). */
function loadGlassModeFromStorage(): boolean {
  try {
    return localStorage.getItem('tianshu.glassMode') === '1'
  } catch {
    return false
  }
}
