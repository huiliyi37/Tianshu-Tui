// Font-weight preference (normal | medium | bold). Persisted to localStorage and
// applied as [data-font-weight] on <html>. Boosts all three semantic weight
// tokens so headings and strong text scale together.

export type FontWeightPref = 'normal' | 'medium' | 'bold'

const KEY = 'tianshu.fontWeight'

export function loadFontWeightPref(): FontWeightPref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'normal' || v === 'medium' || v === 'bold') return v
  } catch {
    // disabled storage — fall through
  }
  return 'normal'
}

export function saveFontWeightPref(pref: FontWeightPref): void {
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    // non-fatal
  }
}

export function applyFontWeight(pref: FontWeightPref): void {
  document.documentElement.dataset.fontWeight = pref
}

export function initFontWeight(): void {
  applyFontWeight(loadFontWeightPref())
}

export function setFontWeightPref(pref: FontWeightPref): void {
  saveFontWeightPref(pref)
  applyFontWeight(pref)
}
