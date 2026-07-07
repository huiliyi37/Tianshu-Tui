import { test } from 'node:test'
import assert from 'node:assert/strict'

// Stub the browser globals theme.ts reads (localStorage / matchMedia / document).
class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}
const styleStore = new Map<string, string>()
const g = globalThis as unknown as {
  localStorage: MemStorage
  window: { matchMedia: (q: string) => { matches: boolean; addEventListener(): void; removeEventListener(): void } }
  document: { documentElement: { dataset: Record<string, string>; style: { setProperty(k: string, v: string): void; removeProperty?(k: string): void } } }
}
g.localStorage = new MemStorage()
let systemDark = false
g.window = {
  matchMedia: () => ({ matches: systemDark, addEventListener() {}, removeEventListener() {} }),
}
g.document = {
  documentElement: {
    dataset: {},
    style: {
      setProperty(k: string, v: string) { styleStore.set(k, v) },
    },
  },
}

const { loadThemePref, saveThemePref, resolveTheme, setThemePref } = await import('../theme.ts')

test('pref persists and defaults to light', () => {
  localStorage.clear()
  // e97f0530：无偏好时默认 light（对齐 Antigravity 2.0 风格改版）
  assert.equal(loadThemePref(), 'light')
  saveThemePref('dark')
  assert.equal(loadThemePref(), 'dark')
})

test('resolveTheme follows system via matchMedia', () => {
  systemDark = true
  assert.equal(resolveTheme('system'), 'dark')
  systemDark = false
  assert.equal(resolveTheme('system'), 'light')
  assert.equal(resolveTheme('dark'), 'dark')
})

test('codex theme prefs persist through loadThemePref whitelist', () => {
  saveThemePref('codex-dark')
  assert.equal(loadThemePref(), 'codex-dark')
  saveThemePref('codex-light')
  assert.equal(loadThemePref(), 'codex-light')
})

test('setThemePref writes data-theme on <html> and CSS variables via setProperty', () => {
  setThemePref('light')
  assert.equal(g.document.documentElement.dataset.theme, 'light')
  // e97f0530：light 主题底色改为暖色 Alabaster
  assert.equal(styleStore.get('--bg'), '#faf8f5', 'should set light --bg')
  setThemePref('dark')
  assert.equal(g.document.documentElement.dataset.theme, 'dark')
  assert.equal(styleStore.get('--bg'), '#1c1c1e', 'should set dark --bg')
})
