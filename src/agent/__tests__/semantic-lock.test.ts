import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SemanticLockManager, getLockCompatibility, type LockIntent } from '../semantic-lock.js'

describe('SemanticLock getLockCompatibility', () => {
  it('edit vs edit is exclusive', () => {
    assert.equal(getLockCompatibility('edit', 'edit'), 'exclusive')
  })
  it('edit vs create is compatible', () => {
    assert.equal(getLockCompatibility('edit', 'create'), 'compatible')
  })
  it('edit vs refactor is conditional', () => {
    assert.equal(getLockCompatibility('edit', 'refactor'), 'conditional')
  })
  it('delete vs anything is exclusive', () => {
    assert.equal(getLockCompatibility('delete', 'edit'), 'exclusive')
    assert.equal(getLockCompatibility('delete', 'create'), 'exclusive')
    assert.equal(getLockCompatibility('delete', 'delete'), 'exclusive')
    assert.equal(getLockCompatibility('delete', 'rename'), 'exclusive')
    assert.equal(getLockCompatibility('delete', 'refactor'), 'exclusive')
  })
  it('rename vs anything is exclusive', () => {
    assert.equal(getLockCompatibility('rename', 'edit'), 'exclusive')
    assert.equal(getLockCompatibility('rename', 'create'), 'exclusive')
    assert.equal(getLockCompatibility('rename', 'refactor'), 'exclusive')
  })
  it('create vs create is compatible', () => {
    assert.equal(getLockCompatibility('create', 'create'), 'compatible')
  })
  it('refactor vs refactor is conditional', () => {
    assert.equal(getLockCompatibility('refactor', 'refactor'), 'conditional')
  })
  it('refactor vs create is compatible', () => {
    assert.equal(getLockCompatibility('refactor', 'create'), 'compatible')
  })
  it('is symmetric', () => {
    const ops = ['edit', 'create', 'delete', 'rename', 'refactor'] as const
    for (const a of ops) {
      for (const b of ops) {
        assert.equal(
          getLockCompatibility(a, b),
          getLockCompatibility(b, a),
          `${a} vs ${b} should equal ${b} vs ${a}`,
        )
      }
    }
  })
})

describe('SemanticLockManager acquire', () => {
  it('acquires lock when no conflicts', () => {
    const mgr = new SemanticLockManager()
    const result = mgr.acquire('s1', { operation: 'edit', files: ['a.ts'], description: '' })
    assert.equal(result.acquired, true)
  })
  it('rejects lock when exclusive conflict', () => {
    const mgr = new SemanticLockManager()
    mgr.acquire('s1', { operation: 'edit', files: ['a.ts'], description: '' })
    const result = mgr.acquire('s2', { operation: 'edit', files: ['a.ts'], description: '' })
    assert.equal(result.acquired, false)
    assert.deepEqual(result.conflictingFiles, ['a.ts'])
  })
  it('allows compatible operations on same file', () => {
    const mgr = new SemanticLockManager()
    mgr.acquire('s1', { operation: 'edit', files: ['a.ts'], description: '' })
    const result = mgr.acquire('s2', { operation: 'create', files: ['a.ts'], description: '' })
    assert.equal(result.acquired, true)
  })
  it('allows same session multiple locks', () => {
    const mgr = new SemanticLockManager()
    mgr.acquire('s1', { operation: 'edit', files: ['a.ts'], description: '' })
    const result = mgr.acquire('s1', { operation: 'edit', files: ['a.ts'], description: '' })
    assert.equal(result.acquired, true)
  })
  it('releases locks', () => {
    const mgr = new SemanticLockManager()
    mgr.acquire('s1', { operation: 'edit', files: ['a.ts'], description: '' })
    mgr.releaseAll('s1')
    const result = mgr.acquire('s2', { operation: 'edit', files: ['a.ts'], description: '' })
    assert.equal(result.acquired, true)
  })
  it('heartbeat keeps locks alive', () => {
    const mgr = new SemanticLockManager({ defaultTtl: 1000 })
    mgr.acquire('s1', { operation: 'edit', files: ['a.ts'], description: '' })
    // Wait a tiny bit so heartbeat differs from acquiredAt
    const start = Date.now()
    while (Date.now() - start < 2) { /* ~2ms */ }
    mgr.heartbeat('s1')
    const locks = mgr.getSessionLocks('s1')
    assert.equal(locks.length, 1)
    assert.ok(locks[0]!.lastHeartbeat >= locks[0]!.acquiredAt)
  })
  it('sweeps expired locks', () => {
    const mgr = new SemanticLockManager({ defaultTtl: 50 })
    mgr.acquire('s1', { operation: 'edit', files: ['a.ts'], description: '' })
    const start = Date.now()
    while (Date.now() - start < 80) { /* busy wait */ }
    const swept = mgr.sweepExpired()
    assert.equal(swept, 1)
    assert.equal(mgr.getAllLocks().length, 0)
  })
  it('detects file locks', () => {
    const mgr = new SemanticLockManager()
    mgr.acquire('s1', { operation: 'edit', files: ['a.ts', 'b.ts'], description: '' })
    assert.equal(mgr.isFileLocked('a.ts'), true)
    assert.equal(mgr.isFileLocked('b.ts'), true)
    assert.equal(mgr.isFileLocked('c.ts'), false)
    assert.equal(mgr.isFileLocked('a.ts', 's1'), false)
  })
  it('acquireAll is atomic', () => {
    const mgr = new SemanticLockManager()
    mgr.acquire('s2', { operation: 'edit', files: ['b.ts'], description: '' })
    const result = mgr.acquireAll('s1', [
      { operation: 'edit', files: ['a.ts'], description: '' },
      { operation: 'edit', files: ['b.ts'], description: '' },
    ])
    assert.equal(result.acquired, false)
    assert.equal(mgr.getSessionLocks('s1').length, 0)
  })
  it('getFileLocks returns correct locks', () => {
    const mgr = new SemanticLockManager()
    mgr.acquire('s1', { operation: 'edit', files: ['a.ts'], description: '' })
    mgr.acquire('s2', { operation: 'create', files: ['a.ts', 'c.ts'], description: '' })
    const locks = mgr.getFileLocks('a.ts')
    assert.equal(locks.length, 2)
  })
})
