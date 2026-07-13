import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}

const g = globalThis as unknown as { localStorage: MemStorage }
g.localStorage = new MemStorage()

const {
  compareSemver,
  isGreaterVersion,
  loadLastSeenVersion,
  saveLastSeenVersion,
  getCurrentVersion,
  getNotesSince,
} = await import('../release-notes.ts')

beforeEach(() => {
  localStorage.clear()
})

test('compareSemver orders numeric versions', () => {
  assert.equal(compareSemver('2.18.0', '2.18.0'), 0)
  assert.equal(compareSemver('2.18.0', '2.17.4'), 1)
  assert.equal(compareSemver('2.9.0', '2.10.0'), -1)
  assert.equal(compareSemver('3.0.0', '2.99.99'), 1)
})

test('isGreaterVersion', () => {
  assert.equal(isGreaterVersion('2.18.0', '2.17.0'), true)
  assert.equal(isGreaterVersion('2.17.0', '2.18.0'), false)
  assert.equal(isGreaterVersion('2.18.0', '2.18.0'), false)
})

test('last seen version persists', () => {
  assert.equal(loadLastSeenVersion(), null)
  saveLastSeenVersion('2.17.0')
  assert.equal(loadLastSeenVersion(), '2.17.0')
})

test('getCurrentVersion falls back to package.json in non-Tauri env', async () => {
  const v = await getCurrentVersion()
  assert.match(v, /^\d+\.\d+\.\d+/)
})

test('getNotesSince filters by version', () => {
  const notes = getNotesSince('2.17.0')
  assert.ok(notes.length > 0)
  assert.ok(notes.every((n) => isGreaterVersion(n.version, '2.17.0')))
})
