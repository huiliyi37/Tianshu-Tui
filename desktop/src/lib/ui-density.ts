// UI Density preference (P0). compact|cozy|spacious, persisted to localStorage
// and applied as [data-density] on <html> to scale spacing and typography.

export type UiDensity = 'compact' | 'cozy' | 'spacious'

const KEY = 'tianshu.uiDensity'

export function loadUiDensity(): UiDensity {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'compact' || v === 'cozy' || v === 'spacious') return v
  } catch {
    // non-fatal
  }
  return 'cozy' // Default to cozy (standard)
}

export function saveUiDensity(density: UiDensity): void {
  try {
    localStorage.setItem(KEY, density)
  } catch {
    // non-fatal
  }
}

export function applyUiDensity(density: UiDensity): void {
  const root = document.documentElement
  root.setAttribute('data-density', density)
}

export function initUiDensity(): void {
  applyUiDensity(loadUiDensity())
}
