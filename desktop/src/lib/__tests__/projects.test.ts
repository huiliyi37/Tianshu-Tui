import { test } from 'node:test'
import assert from 'node:assert/strict'

// Minimal localStorage stub (Node has none) for the known-projects round trip.
class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}
;(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage()

const {
  basename,
  deriveProjects,
  addKnownProject,
  loadKnownProjects,
  removeKnownProject,
} = await import('../projects.ts')

test('basename handles trailing slash and both separators', () => {
  assert.equal(basename('/Users/x/app'), 'app')
  assert.equal(basename('/Users/x/app/'), 'app')
  assert.equal(basename('C:\\foo\\bar'), 'bar')
  assert.equal(basename(''), '')
})

test('deriveProjects dedupes by cwd, counts threads, sorts by activity', () => {
  const sessions = [
    { cwd: '/a/x', updatedAt: 2 },
    { cwd: '/a/x', updatedAt: 5 },
    { cwd: '/b/y', updatedAt: 3 },
  ]
  const projects = deriveProjects(sessions, ['/c/z'])
  assert.equal(projects.length, 3)
  // sorted by lastActivity desc: x(5) > y(3) > z(0)
  assert.deepEqual(projects.map((p) => p.name), ['x', 'y', 'z'])
  const x = projects.find((p) => p.cwd === '/a/x')!
  assert.equal(x.threadCount, 2)
  assert.equal(x.lastActivity, 5)
  const z = projects.find((p) => p.cwd === '/c/z')!
  assert.equal(z.threadCount, 0) // empty known project still appears
})

test('known projects round trip + dedupe', () => {
  localStorage.clear()
  addKnownProject('/p1')
  addKnownProject('/p1') // no dup
  addKnownProject('/p2')
  assert.deepEqual(loadKnownProjects(), ['/p2', '/p1'])
  removeKnownProject('/p1')
  assert.deepEqual(loadKnownProjects(), ['/p2'])
})
