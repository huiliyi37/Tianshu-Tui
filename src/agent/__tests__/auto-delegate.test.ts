import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { shouldAutoDelegate, filterByCircuitState, type AutoDelegateContext } from '../auto-delegate.js'
import { CircuitBreakerManager } from '../worker-circuit-breaker.js'

describe('shouldAutoDelegate', () => {
  let cb: CircuitBreakerManager

  beforeEach(() => {
    cb = new CircuitBreakerManager({ failureThreshold: 3, cheapCooldownMs: 100, defaultCooldownMs: 200 })
  })

  function ctx(overrides: Partial<AutoDelegateContext>): AutoDelegateContext {
    return {
      toolName: 'edit_file',
      affectedFiles: ['src/foo.ts'],
      sessionModifiedFileCount: 1,
      circuitBreaker: cb,
      ...overrides,
    }
  }

  describe('after edit_file', () => {
    it('queues lint_fixer and type_fixer', () => {
      const plan = shouldAutoDelegate(ctx({ toolName: 'edit_file', affectedFiles: ['src/bar.ts'] }))
      assert.ok(plan)
      assert.equal(plan.items.length, 2)
      assert.ok(plan.items.some(i => i.profile === 'lint_fixer'))
      assert.ok(plan.items.some(i => i.profile === 'type_fixer'))
    })

    it('skips lint_fixer when its circuit is open', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      const plan = shouldAutoDelegate(ctx({ toolName: 'edit_file' }))
      assert.ok(plan)
      assert.ok(!plan.items.some(i => i.profile === 'lint_fixer'))
      assert.ok(plan.items.some(i => i.profile === 'type_fixer'))
    })
  })

  describe('after write_file', () => {
    it('queues lint_fixer for test files', () => {
      const plan = shouldAutoDelegate(ctx({
        toolName: 'write_file',
        affectedFiles: ['src/__tests__/foo.test.ts'],
      }))
      assert.ok(plan)
      assert.ok(plan.items.some(i => i.profile === 'lint_fixer'))
    })

    it('queues type_fixer for source files', () => {
      const plan = shouldAutoDelegate(ctx({
        toolName: 'write_file',
        affectedFiles: ['src/utils.ts'],
      }))
      assert.ok(plan)
      assert.ok(plan.items.some(i => i.profile === 'type_fixer'))
    })
  })

  describe('large refactor (5+ files)', () => {
    it('queues import_organizer and doc_syncer', () => {
      const plan = shouldAutoDelegate(ctx({
        sessionModifiedFileCount: 5,
        affectedFiles: ['a.ts', 'b.ts', 'c.ts'],
      }))
      assert.ok(plan)
      assert.ok(plan.items.some(i => i.profile === 'import_organizer'))
      assert.ok(plan.items.some(i => i.profile === 'doc_syncer'))
    })

    it('does not trigger for fewer than 5 files', () => {
      const plan = shouldAutoDelegate(ctx({
        sessionModifiedFileCount: 4,
        affectedFiles: ['a.ts'],
      }))
      assert.ok(plan)
      // Only edit_file defaults (lint + type), not large refactor workers
      assert.ok(!plan.items.some(i => i.profile === 'import_organizer'))
      assert.ok(!plan.items.some(i => i.profile === 'doc_syncer'))
    })
  })

  describe('no delegation', () => {
    it('returns null for unrecognized tool names', () => {
      const plan = shouldAutoDelegate(ctx({ toolName: 'read_file', affectedFiles: [] }))
      assert.equal(plan, null)
    })

    it('returns null when all circuits are open', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')
      for (let i = 0; i < 3; i++) cb.recordFailure('type_fixer')
      const plan = shouldAutoDelegate(ctx({ toolName: 'edit_file', affectedFiles: ['x.ts'] }))
      assert.equal(plan, null)
    })
  })
})

describe('filterByCircuitState', () => {
  it('removes items with open circuits', () => {
    const cb = new CircuitBreakerManager({ failureThreshold: 3, cheapCooldownMs: 100, defaultCooldownMs: 200 })
    for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')

    const plan = {
      items: [
        { profile: 'lint_fixer' as const, files: ['a.ts'], objective: 'lint' },
        { profile: 'type_fixer' as const, files: ['a.ts'], objective: 'type' },
      ],
      reason: 'test',
    }
    const filtered = filterByCircuitState(plan, cb)
    assert.ok(filtered)
    assert.equal(filtered.items.length, 1)
    assert.equal(filtered.items[0]!.profile, 'type_fixer')
  })

  it('returns null when all items are filtered out', () => {
    const cb = new CircuitBreakerManager({ failureThreshold: 3, cheapCooldownMs: 100, defaultCooldownMs: 200 })
    for (let i = 0; i < 3; i++) cb.recordFailure('lint_fixer')

    const plan = {
      items: [{ profile: 'lint_fixer' as const, files: ['a.ts'], objective: 'lint' }],
      reason: 'test',
    }
    assert.equal(filterByCircuitState(plan, cb), null)
  })
})
