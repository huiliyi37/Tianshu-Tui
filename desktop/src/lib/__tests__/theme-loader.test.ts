import { test } from 'node:test'
import assert from 'node:assert/strict'

// Stub browser globals for theme-loader.ts
class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}
const styleProps = new Map<string, string>()
const g = globalThis as unknown as {
  localStorage: MemStorage
  window: { matchMedia: (q: string) => { matches: boolean; addEventListener(): void; removeEventListener(): void } }
  document: { documentElement: { dataset: Record<string, string>; style: { setProperty(k: string, v: string): void } } }
}
g.localStorage = new MemStorage()
g.window = {
  matchMedia: (_q: string) => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
}
g.document = {
  documentElement: {
    dataset: {},
    style: { setProperty(k: string, v: string) { styleProps.set(k, v) } },
  },
}

// Import theme-loader functions
const { loadThemeJson, applyThemeJson } = await import('../theme-loader.ts')
// Import dark/light/nebula JSON for format validation
import dark from '../../styles/themes/dark.json'
import light from '../../styles/themes/light.json'
import nebula from '../../styles/themes/nebula.json'
import lightClassic from '../../styles/themes/light-classic.json'

// ── JSON format validation ──────────────────────────────────────────

function assertThemeJsonShape(json: unknown, label: string) {
  const t = json as Record<string, unknown>
  assert.ok(t, `${label}: should be an object`)
  assert.equal(typeof t.name, 'string', `${label}: .name must be string`)
  assert.ok(t.colorScheme === 'dark' || t.colorScheme === 'light', `${label}: .colorScheme must be dark|light`)
  assert.ok(t.variables && typeof t.variables === 'object', `${label}: .variables must be object`)
  assert.ok(t.surfaces && typeof t.surfaces === 'object', `${label}: .surfaces must be object`)
  assert.ok(t.glass && typeof t.glass === 'object', `${label}: .glass must be object`)
  // Verify at least one expected key exists
  const vars = t.variables as Record<string, string>
  assert.ok('--bg' in vars, `${label}: variables should have --bg`)
  assert.ok('--accent' in vars, `${label}: variables should have --accent`)
}

test('dark.json is valid ThemeJson', () => assertThemeJsonShape(dark, 'dark'))
test('light.json is valid ThemeJson', () => assertThemeJsonShape(light, 'light'))
test('nebula.json is valid ThemeJson', () => assertThemeJsonShape(nebula, 'nebula'))
test('light-classic.json is valid ThemeJson', () => assertThemeJsonShape(lightClassic, 'light-classic'))

test('light-classic.json glass block has text contrast overrides', () => {
  assert.equal((lightClassic.glass as any)['--link'], '#5c35cc', 'light-classic glass --link override')
  assert.equal((lightClassic.glass as any)['--muted'], '#3a3a44', 'light-classic glass --muted override')
})

test('dark.json glass block has color-mix expressions', () => {
  const sidebarBg = dark.glass['--sidebar-surface-bg']
  assert.ok(sidebarBg.startsWith('color-mix(in oklab'), `dark glass sidebar should be color-mix, got: ${sidebarBg}`)
})

// ── loadThemeJson ───────────────────────────────────────────────────

test('loadThemeJson returns correct theme for dark', () => {
  const json = loadThemeJson('dark')
  assert.equal(json.name, '暗色')
  assert.equal(json.colorScheme, 'dark')
  assert.equal(json.variables['--bg'], '#1c1c1e')
})

test('loadThemeJson returns correct theme for light', () => {
  const json = loadThemeJson('light')
  assert.equal(json.colorScheme, 'light')
  // e97f0530：默认 light 主题升级为暖色 Alabaster/米白
  assert.equal(json.variables['--bg'], '#faf8f5')
})

test('loadThemeJson returns correct theme for nebula', () => {
  const json = loadThemeJson('nebula')
  assert.equal(json.name, '星云')
  assert.equal(json.variables['--bg'], '#05050a')
})

// ── applyThemeJson ──────────────────────────────────────────────────

test('applyThemeJson sets base variables via setProperty', () => {
  styleProps.clear()
  applyThemeJson('dark', false)
  assert.equal(styleProps.get('--bg'), '#1c1c1e', 'should set --bg')
  assert.equal(styleProps.get('--accent'), '#5e6ad2', 'should set --accent')
  assert.equal(styleProps.get('color-scheme'), 'dark', 'should set color-scheme')
})

test('applyThemeJson sets data-theme attribute', () => {
  g.document.documentElement.dataset = {}
  applyThemeJson('light', false)
  assert.equal(g.document.documentElement.dataset.theme, 'light')
  applyThemeJson('dark', false)
  assert.equal(g.document.documentElement.dataset.theme, 'dark')
})

test('applyThemeJson(glass=false) writes solid surface tokens', () => {
  styleProps.clear()
  applyThemeJson('dark', false)
  assert.equal(styleProps.get('--sidebar-surface-bg'), 'var(--panel)', 'solid sidebar bg should reference var(--panel)')
  assert.equal(styleProps.get('--sidebar-surface-blur'), '0px', 'solid sidebar blur should be 0')
})

test('applyThemeJson(glass=true) writes glass surface tokens', () => {
  styleProps.clear()
  applyThemeJson('dark', true)
  const sidebarBg = styleProps.get('--sidebar-surface-bg')!
  assert.ok(sidebarBg.startsWith('color-mix'), `glass sidebar bg should be color-mix, got: ${sidebarBg}`)
  assert.notEqual(styleProps.get('--sidebar-surface-blur'), '0px', 'glass sidebar blur should not be 0')
})

test('applyThemeJson respects prefers-reduced-transparency', () => {
  // Simulate OS reduced transparency
  g.window.matchMedia = (q: string) => {
    void q
    return { matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }
  }
  styleProps.clear()
  applyThemeJson('dark', true) // glass=true but reduced transparency forced
  // Should write solid surface tokens despite glass=true
  assert.equal(styleProps.get('--sidebar-surface-bg'), 'var(--panel)', 'reduced transparency should force solid surfaces')
  // Reset
  g.window.matchMedia = (q: string) => {
    void q
    return { matches: false, addEventListener() {}, removeEventListener() {} }
  }
})

test('applyThemeJson writes light-classic theme glass text overrides', () => {
  styleProps.clear()
  applyThemeJson('light-classic', true)
  assert.equal(styleProps.get('--link'), '#5c35cc', 'light-classic glass --link override')
  assert.equal(styleProps.get('--muted'), '#3a3a44', 'light-classic glass --muted override')
})

test('applyThemeJson writes nebula accent with glow', () => {
  styleProps.clear()
  applyThemeJson('nebula', false)
  assert.equal(styleProps.get('--accent-soft'), 'rgba(94, 106, 210, 0.16)', 'nebula accent-soft')
})
