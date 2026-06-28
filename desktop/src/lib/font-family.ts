// Font family preference (sans | kaiti | geometric | mono). Persisted to localStorage and
// applied as [data-font-family] on <html>.
export type FontFamilyPref = 'sans' | 'kaiti' | 'geometric' | 'mono'

const KEY = 'tianshu.fontWeight.family' // avoid key name collision

export function loadFontFamilyPref(): FontFamilyPref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'sans' || v === 'kaiti' || v === 'geometric' || v === 'mono') return v
  } catch {
    // disabled storage
  }
  return 'sans'
}

export function saveFontFamilyPref(pref: FontFamilyPref): void {
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    // non-fatal
  }
}

export function applyFontFamily(pref: FontFamilyPref): void {
  document.documentElement.dataset.fontFamily = pref
}

export function initFontFamily(): void {
  applyFontFamily(loadFontFamilyPref())
}

export function setFontFamilyPref(pref: FontFamilyPref): void {
  saveFontFamilyPref(pref)
  applyFontFamily(pref)
}
