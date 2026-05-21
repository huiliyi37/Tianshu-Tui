/**
 * Tests for ConflictGradient — 四色冲突梯度检测
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectConflictGradient,
  assessIntentConflict,
  conflictLevelValue,
  isWorseThan,
  type ConflictLevel,
} from '../conflict-gradient.js'
import type { SemanticLock, LockIntent } from '../semantic-lock.js'

function makeLock(sessionId: string, intent: LockIntent): SemanticLock {
  return {
    sessionId,
    intent,
    acquiredAt: Date.now(),
    lastHeartbeat: Date.now(),
    ttl: 3600000,
  }
}

describe('ConflictGradient', () => {
  describe('conflictLevelValue', () => {
    it('orders correctly', () => {
      assert.ok(conflictLevelValue('green') < conflictLevelValue('yellow'))
      assert.ok(conflictLevelValue('yellow') < conflictLevelValue('orange'))
      assert.ok(conflictLevelValue('orange') < conflictLevelValue('red'))
    })
  })

  describe('isWorseThan', () => {
    it('green is not worse than anything', () => {
      assert.equal(isWorseThan('green', 'green'), false)
      assert.equal(isWorseThan('green', 'yellow'), false)
    })

    it('red is worse than everything', () => {
      assert.equal(isWorseThan('red', 'green'), true)
      assert.equal(isWorseThan('red', 'yellow'), true)
      assert.equal(isWorseThan('red', 'orange'), true)
    })
  })

  describe('detectConflictGradient', () => {
    it('returns green for empty locks', () => {
      const result = detectConflictGradient([], [])
      assert.equal(result.level, 'green')
    })

    it('returns green for same session', () => {
      const lock = makeLock('s1', { operation: 'edit', files: ['a.ts'], description: '' })
      const result = detectConflictGradient([lock], [lock])
      assert.equal(result.level, 'green')
    })

    it('returns green for no file overlap', () => {
      const lockA = makeLock('s1', { operation: 'edit', files: ['a.ts'], description: '' })
      const lockB = makeLock('s2', { operation: 'edit', files: ['b.ts'], description: '' })
      const result = detectConflictGradient([lockA], [lockB])
      assert.equal(result.level, 'green')
    })

    it('returns red for edit vs edit on same file', () => {
      const lockA = makeLock('s1', { operation: 'edit', files: ['a.ts'], description: '' })
      const lockB = makeLock('s2', { operation: 'edit', files: ['a.ts'], description: '' })
      const result = detectConflictGradient([lockA], [lockB])
      assert.equal(result.level, 'red')
      assert.deepEqual(result.overlappingFiles, ['a.ts'])
    })

    it('returns yellow for edit vs create on same file', () => {
      const lockA = makeLock('s1', { operation: 'edit', files: ['a.ts'], description: '' })
      const lockB = makeLock('s2', { operation: 'create', files: ['a.ts'], description: '' })
      const result = detectConflictGradient([lockA], [lockB])
      assert.equal(result.level, 'yellow')
    })

    it('returns orange for edit vs refactor on same file (without domain hints)', () => {
      const lockA = makeLock('s1', { operation: 'edit', files: ['a.ts'], description: '' })
      const lockB = makeLock('s2', { operation: 'refactor', files: ['a.ts'], description: '' })
      const result = detectConflictGradient([lockA], [lockB])
      assert.equal(result.level, 'orange')
    })

    it('returns yellow for refactor vs refactor with complementary domains', () => {
      const lockA = makeLock('s1', {
        operation: 'refactor',
        files: ['a.ts'],
        description: '',
        domainHints: ['frontend'],
      })
      const lockB = makeLock('s2', {
        operation: 'refactor',
        files: ['a.ts'],
        description: '',
        domainHints: ['backend'],
      })
      const result = detectConflictGradient([lockA], [lockB])
      assert.equal(result.level, 'yellow')
    })

    it('returns red for delete vs anything on same file', () => {
      const lockA = makeLock('s1', { operation: 'delete', files: ['a.ts'], description: '' })
      const lockB = makeLock('s2', { operation: 'edit', files: ['a.ts'], description: '' })
      const result = detectConflictGradient([lockA], [lockB])
      assert.equal(result.level, 'red')
    })
  })

  describe('assessIntentConflict', () => {
    it('returns green when no other locks exist', () => {
      const intent: LockIntent = { operation: 'edit', files: ['a.ts'], description: '' }
      const result = assessIntentConflict(intent, [], 's1')
      assert.equal(result.level, 'green')
    })

    it('returns red when conflicting lock exists', () => {
      const existing = makeLock('s2', { operation: 'edit', files: ['a.ts'], description: '' })
      const intent: LockIntent = { operation: 'edit', files: ['a.ts'], description: '' }
      const result = assessIntentConflict(intent, [existing], 's1')
      assert.equal(result.level, 'red')
    })

    it('ignores own session locks', () => {
      const ownLock = makeLock('s1', { operation: 'edit', files: ['a.ts'], description: '' })
      const intent: LockIntent = { operation: 'edit', files: ['a.ts'], description: '' }
      const result = assessIntentConflict(intent, [ownLock], 's1')
      assert.equal(result.level, 'green')
    })
  })
})
