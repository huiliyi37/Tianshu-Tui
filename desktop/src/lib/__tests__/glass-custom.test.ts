import { test } from 'node:test'
import assert from 'node:assert/strict'

// Stub localStorage + document.documentElement.style for glass-custom.ts
class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}
const g = globalThis as unknown as {
  localStorage: MemStorage
  document: { documentElement: { style: Record<string, string> & { setProperty(k: string, v: string): void } } }
}
g.localStorage = new MemStorage()
const cssProps: Record<string, string> = {}
function setCssProp(k: string, v: string): void { cssProps[k] = v }
g.document = {
  documentElement: {
    style: new Proxy(cssProps, { set: (t, k: string, v) => { t[k] = v; return true } }) as Record<string, string> & { setProperty(k: string, v: string): void },
  },
}
Object.assign(g.document.documentElement.style, { setProperty: setCssProp })

const { loadGlassConfig, saveGlassConfig, applyGlassConfig, initGlassCustom, DEFAULT_GLASS_CONFIG } = await import('../glass-custom.ts')

test('DEFAULT_GLASS_CONFIG has expected defaults', () => {
  assert.equal(DEFAULT_GLASS_CONFIG.sidebarOpacity, 80)
  assert.equal(DEFAULT_GLASS_CONFIG.sidebarBlur, 24)
  assert.equal(DEFAULT_GLASS_CONFIG.mainOpacity, 90)
  assert.equal(DEFAULT_GLASS_CONFIG.mainBlur, 16)
})

test('loadGlassConfig returns defaults when localStorage is empty', () => {
  localStorage.clear()
  const cfg = loadGlassConfig()
  assert.deepEqual(cfg, DEFAULT_GLASS_CONFIG)
})

test('save + loadGlassConfig round-trips', () => {
  localStorage.clear()
  const modified = { sidebarOpacity: 50, sidebarBlur: 32, mainOpacity: 70, mainBlur: 8 }
  saveGlassConfig(modified)
  const loaded = loadGlassConfig()
  assert.deepEqual(loaded, modified)
})

test('loadGlassConfig falls back to defaults on malformed JSON', () => {
  localStorage.clear()
  localStorage.setItem('tianshu.glassCustom', '{garbage')
  const cfg = loadGlassConfig()
  assert.deepEqual(cfg, DEFAULT_GLASS_CONFIG)
})

test('loadGlassConfig corrects individual bad fields', () => {
  localStorage.clear()
  localStorage.setItem('tianshu.glassCustom', JSON.stringify({ sidebarOpacity: 'not-a-number', sidebarBlur: 12, mainOpacity: 80, mainBlur: 16 }))
  const cfg = loadGlassConfig()
  assert.equal(cfg.sidebarOpacity, DEFAULT_GLASS_CONFIG.sidebarOpacity) // bad field → default
  assert.equal(cfg.sidebarBlur, 12) // good field preserved
})

test('applyGlassConfig sets CSS custom properties on documentElement', () => {
  applyGlassConfig({ sidebarOpacity: 60, sidebarBlur: 20, mainOpacity: 85, mainBlur: 10 })
  assert.equal(cssProps['--sidebar-glass-opacity'], '60%')
  assert.equal(cssProps['--sidebar-glass-blur'], '20px')
  assert.equal(cssProps['--main-glass-opacity'], '85%')
  assert.equal(cssProps['--main-glass-blur'], '10px')
})

test('initGlassCustom loads and applies', () => {
  localStorage.clear()
  saveGlassConfig({ sidebarOpacity: 77, sidebarBlur: 18, mainOpacity: 66, mainBlur: 6 })
  initGlassCustom()
  assert.equal(cssProps['--sidebar-glass-opacity'], '77%')
})
