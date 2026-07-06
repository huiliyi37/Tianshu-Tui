import type { ResolvedTheme } from './theme'
import type { ThemeJson } from './theme-types'
import dark from '../styles/themes/dark.json'
import light from '../styles/themes/light.json'
import nebula from '../styles/themes/nebula.json'
import sakura from '../styles/themes/sakura.json'
import cyberpunk from '../styles/themes/cyberpunk.json'
import cupertino from '../styles/themes/cupertino.json'
import lightClassic from '../styles/themes/light-classic.json'
import codexDark from '../styles/themes/codex-dark.json'
import codexLight from '../styles/themes/codex-light.json'

const THEMES: Record<ResolvedTheme, ThemeJson> = {
  dark: dark as ThemeJson,
  light: light as ThemeJson,
  nebula: nebula as ThemeJson,
  sakura: sakura as ThemeJson,
  cyberpunk: cyberpunk as ThemeJson,
  cupertino: cupertino as ThemeJson,
  'light-classic': lightClassic as ThemeJson,
  'codex-dark': codexDark as ThemeJson,
  'codex-light': codexLight as ThemeJson,
}

export function loadThemeJson(resolved: ResolvedTheme): ThemeJson {
  return THEMES[resolved]
}

/** Check whether the OS "reduce transparency" accessibility setting is active. */
function prefersReducedTransparency(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-transparency: reduce)').matches
  } catch {
    return false
  }
}

/**
 * Apply all theme variables (base colors + surface tokens) to :root via
 * setProperty. Caller (theme.ts) resolves ThemePref → ResolvedTheme first.
 * When `glass` is true, glass-mode surface tokens are written; otherwise
 * solid surface tokens are used. Respects OS reduced-transparency preference.
 */
export function applyThemeJson(resolved: ResolvedTheme, glass: boolean): void {
  const json = loadThemeJson(resolved)
  const effectiveGlass = glass && !prefersReducedTransparency()
  const root = document.documentElement

  // 1. color-scheme
  root.style.setProperty('color-scheme', json.colorScheme)

  // 2. base variables
  for (const [k, v] of Object.entries(json.variables)) {
    root.style.setProperty(k, v)
  }

  // 3. surface tokens (glass or solid)
  const surfaceBlock = effectiveGlass ? json.glass : json.surfaces
  for (const [k, v] of Object.entries(surfaceBlock)) {
    root.style.setProperty(k, v)
  }

  // 4. data-theme attribute (for styles.css star-domain accent overrides)
  root.dataset.theme = resolved
}
