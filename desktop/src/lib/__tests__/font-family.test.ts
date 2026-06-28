import { test } from 'node:test'
import assert from 'node:assert/strict'

class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}
const g = globalThis as unknown as {
  localStorage: MemStorage
  document: { documentElement: { dataset: Record<string, string> } }
}
g.localStorage = new MemStorage()
g.document = { documentElement: { dataset: {} } }

const { loadFontFamilyPref, saveFontFamilyPref, applyFontFamily, initFontFamily, setFontFamilyPref } = await import('../font-family.ts')

test('loadFontFamilyPref defaults to sans when empty', () => {
  localStorage.clear()
  assert.equal(loadFontFamilyPref(), 'sans')
})

test('loadFontFamilyPref defaults to sans on garbage value', () => {
  localStorage.clear()
  localStorage.setItem('tianshu.fontWeight.family', 'comic-sans')
  assert.equal(loadFontFamilyPref(), 'sans')
})

test('save + loadFontFamilyPref round-trips', () => {
  localStorage.clear()
  for (const val of ['sans', 'kaiti', 'geometric', 'mono'] as const) {
    saveFontFamilyPref(val)
    assert.equal(loadFontFamilyPref(), val)
  }
})

test('applyFontFamily sets data-font-family on html', () => {
  applyFontFamily('kaiti')
  assert.equal(g.document.documentElement.dataset.fontFamily, 'kaiti')
  applyFontFamily('sans')
  assert.equal(g.document.documentElement.dataset.fontFamily, 'sans')
})

test('initFontFamily loads and applies', () => {
  localStorage.clear()
  saveFontFamilyPref('geometric')
  initFontFamily()
  assert.equal(g.document.documentElement.dataset.fontFamily, 'geometric')
})

test('setFontFamilyPref persists and applies', () => {
  localStorage.clear()
  setFontFamilyPref('mono')
  assert.equal(localStorage.getItem('tianshu.fontWeight.family'), 'mono')
  assert.equal(g.document.documentElement.dataset.fontFamily, 'mono')
})

test('loadFontFamilyPref handles disabled storage gracefully', () => {
  // When localStorage is unavailable, should return default
  const saved = g.localStorage
  ;(g as any).localStorage = undefined
  const result = loadFontFamilyPref()
  assert.equal(result, 'sans')
  ;(g as any).localStorage = saved
})
