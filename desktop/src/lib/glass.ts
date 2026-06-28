// Glass-mode preference: enables translucent surfaces + backdrop blur even when
// no custom wallpaper is set. Stored in localStorage and broadcast via a custom
// event so consumers can react without a full context provider.

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

export function applyGlassMode(value: GlassMode): void {
  const root = document.documentElement
  if (value) root.setAttribute('data-surface', 'glass')
  else root.removeAttribute('data-surface')
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
    },
  ]
}
