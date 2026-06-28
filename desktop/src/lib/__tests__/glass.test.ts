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
const g = globalThis as unknown as {
  localStorage: MemStorage
  window: { dispatchEvent(e: Event): boolean }
  document: { documentElement: { setAttribute(k: string, v: string): void; getAttribute(k: string): string | null } }
}
g.localStorage = new MemStorage()
g.window = { dispatchEvent: (e: Event) => { dispatchedEvent = e.type; return true } }
g.document = {
  documentElement: {
    _attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this._attrs[k] = v },
    getAttribute(k: string) { return this._attrs[k] ?? null },
    removeAttribute(k: string) { delete this._attrs[k] },
  },
}

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

test('applyGlassMode sets data-surface attribute', () => {
  applyGlassMode(true)
  assert.equal(g.document.documentElement.getAttribute('data-surface'), 'glass')
  applyGlassMode(false)
  assert.equal(g.document.documentElement.getAttribute('data-surface'), null)
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
