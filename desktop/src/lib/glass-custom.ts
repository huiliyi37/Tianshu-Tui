export interface GlassConfig {
  sidebarOpacity: number // 10-100
  sidebarBlur: number // 0-64
  mainOpacity: number // 10-100
  mainBlur: number // 0-64
}

const KEY = 'tianshu.glassCustom'

export const DEFAULT_GLASS_CONFIG: GlassConfig = {
  sidebarOpacity: 80,
  sidebarBlur: 24,
  mainOpacity: 90,
  mainBlur: 16,
}

export function loadGlassConfig(): GlassConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as GlassConfig
      return {
        sidebarOpacity: typeof parsed.sidebarOpacity === 'number' ? parsed.sidebarOpacity : DEFAULT_GLASS_CONFIG.sidebarOpacity,
        sidebarBlur: typeof parsed.sidebarBlur === 'number' ? parsed.sidebarBlur : DEFAULT_GLASS_CONFIG.sidebarBlur,
        mainOpacity: typeof parsed.mainOpacity === 'number' ? parsed.mainOpacity : DEFAULT_GLASS_CONFIG.mainOpacity,
        mainBlur: typeof parsed.mainBlur === 'number' ? parsed.mainBlur : DEFAULT_GLASS_CONFIG.mainBlur,
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_GLASS_CONFIG
}

export function applyGlassConfig(config: GlassConfig): void {
  const root = document.documentElement
  root.style.setProperty('--sidebar-glass-opacity', `${config.sidebarOpacity}%`)
  root.style.setProperty('--sidebar-glass-blur', `${config.sidebarBlur}px`)
  root.style.setProperty('--main-glass-opacity', `${config.mainOpacity}%`)
  root.style.setProperty('--main-glass-blur', `${config.mainBlur}px`)
}

export function initGlassCustom(): void {
  applyGlassConfig(loadGlassConfig())
}

export function saveGlassConfig(config: GlassConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(config))
    applyGlassConfig(config)
  } catch {
    // ignore
  }
}
