import { test } from 'node:test'
import assert from 'node:assert/strict'

class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}

let dispatchedEvent: string | null = null
const styleProps = new Map<string, string>()
const g = globalThis as unknown as {
  localStorage: MemStorage
  window: { dispatchEvent(e: Event): boolean; matchMedia(q: string): { matches: boolean; addEventListener(): void; removeEventListener(): void } }
  document: { documentElement: { setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; removeAttribute(k: string): void; dataset: Record<string, string>; style: { setProperty(k: string, v: string): void } } }
}
g.localStorage = new MemStorage()
g.window = {
  dispatchEvent: (e: Event) => { dispatchedEvent = e.type; return true },
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const docEl: any = {
  _attrs: {} as Record<string, string>,
  dataset: {} as Record<string, string>,
  setAttribute(k: string, v: string) { this._attrs[k] = v },
  getAttribute(k: string) { return this._attrs[k] ?? null },
  removeAttribute(k: string) { delete this._attrs[k] },
  style: { setProperty(k: string, v: string) { styleProps.set(k, v) } },
}
g.document = { documentElement: docEl }

const { loadGlassMode, saveGlassMode, applyGlassMode, initGlassMode } = await import('../glass.ts')

test('loadGlassMode defaults to false when empty', () => {
  localStorage.clear()
  assert.equal(loadGlassMode(), false)
})

test('save + loadGlassMode round-trips true/false', () => {
  localStorage.clear()
  saveGlassMode(true)
  assert.equal(loadGlassMode(), true)
  saveGlassMode(false)
  assert.equal(loadGlassMode(), false)
})

test('applyGlassMode sets data-surface attribute and applies surface tokens', () => {
  styleProps.clear()
  applyGlassMode(true)
  assert.equal(g.document.documentElement.getAttribute('data-surface'), 'glass')
  assert.ok(styleProps.has('--sidebar-surface-bg'), 'should set glass surface tokens')
  applyGlassMode(false)
  assert.equal(g.document.documentElement.getAttribute('data-surface'), null)
  assert.ok(styleProps.has('--sidebar-surface-bg'), 'should set solid surface tokens')
})

test('initGlassMode loads persisted value and applies', () => {
  localStorage.clear()
  saveGlassMode(true)
  initGlassMode()
  assert.equal(g.document.documentElement.getAttribute('data-surface'), 'glass')
})

test('saveGlassMode dispatches tianshu:glasschange event', () => {
  dispatchedEvent = null
  saveGlassMode(true)
  assert.equal(dispatchedEvent, 'tianshu:glasschange')
  dispatchedEvent = null
  saveGlassMode(false)
  assert.equal(dispatchedEvent, 'tianshu:glasschange')
})

test('loadGlassMode handles garbage value in storage', () => {
  localStorage.clear()
  localStorage.setItem('tianshu.glassMode', 'not-json')
  assert.equal(loadGlassMode(), false)
})
