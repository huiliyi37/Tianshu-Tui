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
  projectId,
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

test('deriveProjects dedupes by project id, counts threads, sorts by activity', () => {
  const sessions = [
    { cwd: '/a/x', updatedAt: 2 },
    { cwd: '/a/x', updatedAt: 5 },
    { cwd: '/b/y', updatedAt: 3 },
  ]
  const projects = deriveProjects(sessions, [{ id: 'z', roots: ['/c/z'], name: 'z' }])
  assert.equal(projects.length, 3)
  // sorted by lastActivity desc: x(5) > y(3) > z(0)
  assert.deepEqual(projects.map((p) => p.name), ['x', 'y', 'z'])
  const x = projects.find((p) => p.id.startsWith('x-'))!
  assert.equal(x.threadCount, 2)
  assert.equal(x.lastActivity, 5)
  assert.deepEqual(x.roots, ['/a/x'])
  const z = projects.find((p) => p.id === 'z')!
  assert.equal(z.threadCount, 0) // empty known project still appears
})

test('deriveProjects keeps a multi-root project as a single entry', () => {
  const sessions = [{ cwd: '/mono/frontend', updatedAt: 1 }]
  const known = [{ id: 'mono', roots: ['/mono/frontend', '/mono/backend'], name: 'mono' }]
  const projects = deriveProjects(sessions, known)
  const mono = projects.find((p) => p.id === 'mono')!
  assert.ok(mono, 'multi-root project should appear')
  assert.equal(mono.roots.length, 2, 'both roots preserved')
  assert.equal(mono.threadCount, 1)
})

test('known projects round trip + dedupe (new StoredProject shape)', () => {
  localStorage.clear()
  addKnownProject('/p1')
  addKnownProject('/p1') // no dup
  addKnownProject('/p2')
  const loaded = loadKnownProjects()
  assert.equal(loaded.length, 2)
  assert.ok(loaded[0]!.id.startsWith('p2-'), 'most recent project id starts with basename + hash')
  assert.ok(loaded[1]!.id.startsWith('p1-'))
  assert.deepEqual(loaded[1]!.roots, ['/p1'])
  removeKnownProject(loaded[1]!.id)
  assert.equal(loadKnownProjects().length, 1)
})

test('projectId avoids cross-disk basename collisions', () => {
  const id1 = projectId('C:\\Projects\\app')
  const id2 = projectId('D:\\Projects\\app')
  assert.notEqual(id1, id2, 'same basename on different drives must not collide')
  assert.ok(id1.startsWith('app-'))
  assert.ok(id2.startsWith('app-'))
})

test('legacy bare string[] localStorage is migrated to StoredProject[]', () => {
  localStorage.clear()
  // write legacy format directly
  localStorage.setItem('tianshu.knownProjects', JSON.stringify(['/legacy/a', '/legacy/b']))
  const loaded = loadKnownProjects()
  assert.equal(loaded.length, 2)
  assert.ok(loaded.every((p) => Array.isArray(p.roots) && p.roots.length === 1), 'each migrated to single-root')
  assert.ok(loaded[0]!.id.startsWith('a-'), 'migrated id includes path hash')
  // migration should have written back the new format
  const raw = JSON.parse(localStorage.getItem('tianshu.knownProjects')!)
  assert.equal(typeof raw[0], 'object', 'localStorage rewritten to new shape')
})
