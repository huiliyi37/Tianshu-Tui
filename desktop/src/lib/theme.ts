// Theme preference (P0). system|light|dark, persisted to localStorage and applied
// as [data-theme] on <html>. `system` follows prefers-color-scheme live.

export type ThemePref = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'tianshu.theme'

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // disabled storage — fall through
  }
  return 'system'
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

export function applyTheme(pref: ThemePref): void {
  const resolved = resolveTheme(pref)
  document.documentElement.dataset.theme = resolved
}

/**
 * Apply the saved preference and keep it in sync with the OS when set to
 * `system`. Returns a disposer (rarely needed — the app lives for the session).
 */
export function initTheme(): () => void {
  const pref = loadThemePref()
  applyTheme(pref)

  let media: MediaQueryList | null = null
  const onChange = () => {
    if (loadThemePref() === 'system') applyTheme('system')
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
  applyTheme(pref)
}
