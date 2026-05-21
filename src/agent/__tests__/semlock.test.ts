/**
 * Tests for SemanticLock
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SemanticLockManager,
  getLockCompatibility,
  type LockIntent,
} from '../semantic-lock.js'

describe('SemanticLock', () => {
  describe('getLockCompatibility', () => {
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
            `getLockCompatibility(${a}, ${b}) should equal getLockCompatibility(${b}, ${a})`,
          )
        }
      }
    })
  })

  describe('SemanticLockManager', () => {
    it('acquires lock when no conflicts', () => {
      const mgr = new SemanticLockManager()
      const intent: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'editing foo',
      }
      const result = mgr.acquire('session-1', intent)
      assert.equal(result.acquired, true)
      assert.equal(result.conflictingLocks.length, 0)
    })

    it('rejects lock when exclusive conflict', () => {
      const mgr = new SemanticLockManager()
      const intent1: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'editing foo',
      }
      const intent2: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'also editing foo',
      }

      mgr.acquire('session-1', intent1)
      const result = mgr.acquire('session-2', intent2)

      assert.equal(result.acquired, false)
      assert.equal(result.conflictingFiles.length, 1)
      assert.equal(result.conflictingFiles[0], 'src/foo.ts')
    })

    it('allows compatible operations on same file', () => {
      const mgr = new SemanticLockManager()
      const intent1: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'editing foo',
      }
      const intent2: LockIntent = {
        operation: 'create',
        files: ['src/foo.ts'],
        description: 'creating in foo',
      }

      mgr.acquire('session-1', intent1)
      const result = mgr.acquire('session-2', intent2)

      assert.equal(result.acquired, true)
    })

    it('allows same session to acquire multiple locks', () => {
      const mgr = new SemanticLockManager()
      const intent1: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'editing foo',
      }
      const intent2: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'also editing foo',
      }

      mgr.acquire('session-1', intent1)
      const result = mgr.acquire('session-1', intent2)

      assert.equal(result.acquired, true)
    })

    it('releases locks', () => {
      const mgr = new SemanticLockManager()
      const intent: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'editing foo',
      }

      mgr.acquire('session-1', intent)
      mgr.releaseAll('session-1')

      const result = mgr.acquire('session-2', intent)
      assert.equal(result.acquired, true)
    })

    it('heartbeat keeps locks alive', () => {
      const mgr = new SemanticLockManager({ defaultTtl: 1000 })
      const intent: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'editing foo',
      }

      mgr.acquire('session-1', intent)
      mgr.heartbeat('session-1')

      const locks = mgr.getSessionLocks('session-1')
      assert.equal(locks.length, 1)
      assert.ok(locks[0]!.lastHeartbeat > locks[0]!.acquiredAt)
    })

    it('sweeps expired locks', () => {
      const mgr = new SemanticLockManager({ defaultTtl: 50 })
      const intent: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'editing foo',
      }

      mgr.acquire('session-1', intent)

      const start = Date.now()
      while (Date.now() - start < 80) { /* busy wait */ }

      const swept = mgr.sweepExpired()
      assert.equal(swept, 1)
      assert.equal(mgr.getAllLocks().length, 0)
    })

    it('detects file locks', () => {
      const mgr = new SemanticLockManager()
      const intent: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts', 'src/bar.ts'],
        description: 'editing foo and bar',
      }

      mgr.acquire('session-1', intent)
      assert.equal(mgr.isFileLocked('src/foo.ts'), true)
      assert.equal(mgr.isFileLocked('src/bar.ts'), true)
      assert.equal(mgr.isFileLocked('src/baz.ts'), false)
      assert.equal(mgr.isFileLocked('src/foo.ts', 'session-1'), false)
    })

    it('acquireAll is atomic', () => {
      const mgr = new SemanticLockManager()
      const intent1: LockIntent = {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'editing foo',
      }
      const intent2: LockIntent = {
        operation: 'edit',
        files: ['src/bar.ts'],
        description: 'editing bar',
      }

      mgr.acquire('session-2', {
        operation: 'edit',
        files: ['src/bar.ts'],
        description: 'editing bar',
      })

      const result = mgr.acquireAll('session-1', [intent1, intent2])
      assert.equal(result.acquired, false)
      assert.equal(mgr.getSessionLocks('session-1').length, 0)
    })

    it('getFileLocks returns correct locks', () => {
      const mgr = new SemanticLockManager()
      mgr.acquire('session-1', {
        operation: 'edit',
        files: ['src/foo.ts'],
        description: 'editing foo',
      })
      mgr.acquire('session-2', {
        operation: 'create',
        files: ['src/foo.ts', 'src/baz.ts'],
        description: 'creating in foo',
      })

      const locks = mgr.getFileLocks('src/foo.ts')
      assert.equal(locks.length, 2)
    })
  })
})
