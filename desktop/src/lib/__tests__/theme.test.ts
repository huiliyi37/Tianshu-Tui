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
const g = globalThis as unknown as {
  localStorage: MemStorage
  window: { matchMedia: (q: string) => { matches: boolean; addEventListener(): void; removeEventListener(): void } }
  document: { documentElement: { dataset: Record<string, string> } }
}
g.localStorage = new MemStorage()
let systemDark = false
g.window = {
  matchMedia: () => ({ matches: systemDark, addEventListener() {}, removeEventListener() {} }),
}
g.document = { documentElement: { dataset: {} } }

const { loadThemePref, saveThemePref, resolveTheme, setThemePref } = await import('../theme.ts')

test('pref persists and defaults to system', () => {
  localStorage.clear()
  assert.equal(loadThemePref(), 'system')
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

test('setThemePref writes data-theme on <html>', () => {
  setThemePref('light')
  assert.equal(g.document.documentElement.dataset.theme, 'light')
  setThemePref('dark')
  assert.equal(g.document.documentElement.dataset.theme, 'dark')
})
