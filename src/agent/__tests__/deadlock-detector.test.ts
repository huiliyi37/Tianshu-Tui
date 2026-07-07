/**
 * Tests for DeadlockDetector — 图论死锁检测
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWaitForGraph,
  buildFullWaitForGraph,
  detectCycle,
  detectAndResolve,
  type WaitEdge,
} from '../deadlock-detector.js'
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

describe('DeadlockDetector', () => {
  describe('buildWaitForGraph', () => {
    it('returns empty edges when no conflict', () => {
      const intent: LockIntent = { operation: 'edit', files: ['a.ts'], description: '' }
      const activeLocks = [
        makeLock('s2', { operation: 'edit', files: ['b.ts'], description: '' }),
      ]
      const edges = buildWaitForGraph('s1', intent, activeLocks)
      assert.equal(edges.length, 0)
    })

    it('creates edge when file conflict exists', () => {
      const intent: LockIntent = { operation: 'edit', files: ['a.ts'], description: '' }
      const activeLocks = [
        makeLock('s2', { operation: 'edit', files: ['a.ts'], description: '' }),
      ]
      const edges = buildWaitForGraph('s1', intent, activeLocks)
      assert.equal(edges.length, 1)
      assert.equal(edges[0]!.waiter, 's1')
      assert.equal(edges[0]!.holder, 's2')
      assert.equal(edges[0]!.resource, 'a.ts')
    })

    it('ignores compatible operations', () => {
      const intent: LockIntent = { operation: 'create', files: ['a.ts'], description: '' }
      const activeLocks = [
        makeLock('s2', { operation: 'edit', files: ['a.ts'], description: '' }),
      ]
      const edges = buildWaitForGraph('s1', intent, activeLocks)
      assert.equal(edges.length, 0) // create vs edit is compatible
    })
  })

  describe('detectCycle', () => {
    it('returns null for empty edges', () => {
      assert.equal(detectCycle([]), null)
    })

    it('returns null for no cycle', () => {
      const edges: WaitEdge[] = [
        { waiter: 's1', holder: 's2', resource: 'a.ts' },
        { waiter: 's3', holder: 's4', resource: 'b.ts' },
      ]
      assert.equal(detectCycle(edges), null)
    })

    it('detects simple two-node cycle', () => {
      const edges: WaitEdge[] = [
        { waiter: 's1', holder: 's2', resource: 'a.ts' },
        { waiter: 's2', holder: 's1', resource: 'b.ts' },
      ]
      const report = detectCycle(edges)
      assert.notEqual(report, null)
      assert.equal(report!.cycle.length >= 2, true)
      assert.equal(report!.resources.length >= 1, true)
    })

    it('detects three-node cycle', () => {
      const edges: WaitEdge[] = [
        { waiter: 's1', holder: 's2', resource: 'a.ts' },
        { waiter: 's2', holder: 's3', resource: 'b.ts' },
        { waiter: 's3', holder: 's1', resource: 'c.ts' },
      ]
      const report = detectCycle(edges)
      assert.notEqual(report, null)
      assert.ok(report!.cycle.length >= 3)
    })

    it('selects a victim', () => {
      const edges: WaitEdge[] = [
        { waiter: 's1', holder: 's2', resource: 'a.ts' },
        { waiter: 's2', holder: 's1', resource: 'b.ts' },
      ]
      const report = detectCycle(edges)
      assert.notEqual(report, null)
      assert.ok(report!.victim.length > 0)
      assert.ok(report!.cycle.includes(report!.victim))
    })
  })

  describe('detectAndResolve', () => {
    it('returns null when no deadlock', () => {
      const waiters = [
        { sessionId: 's1', intent: { operation: 'edit' as const, files: ['a.ts'], description: '' } },
      ]
      const activeLocks = [
        makeLock('s2', { operation: 'edit', files: ['b.ts'], description: '' }),
      ]
      assert.equal(detectAndResolve(waiters, activeLocks), null)
    })

    it('detects deadlock', () => {
      const waiters = [
        { sessionId: 's1', intent: { operation: 'edit' as const, files: ['a.ts'], description: '' } },
        { sessionId: 's2', intent: { operation: 'edit' as const, files: ['b.ts'], description: '' } },
      ]
      const activeLocks = [
        makeLock('s1', { operation: 'edit', files: ['b.ts'], description: '' }),
        makeLock('s2', { operation: 'edit', files: ['a.ts'], description: '' }),
      ]
      const report = detectAndResolve(waiters, activeLocks)
      assert.notEqual(report, null)
    })
  })

  describe('buildFullWaitForGraph', () => {
    it('combines edges from multiple waiters', () => {
      const waiters = [
        { sessionId: 's1', intent: { operation: 'edit' as const, files: ['a.ts'], description: '' } },
        { sessionId: 's3', intent: { operation: 'edit' as const, files: ['c.ts'], description: '' } },
      ]
      const activeLocks = [
        makeLock('s2', { operation: 'edit', files: ['a.ts'], description: '' }),
        makeLock('s4', { operation: 'edit', files: ['c.ts'], description: '' }),
      ]
      const edges = buildFullWaitForGraph(waiters, activeLocks)
      assert.equal(edges.length, 2)
    })
  })
})
