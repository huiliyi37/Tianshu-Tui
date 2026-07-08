/**
 * Tests for the CPU worker pool inline functions.
 *
 * Pool round-trip correctness (worker thread) is verified by the dist smoke
 * test and direct integration test — the `unref()` worker fundamentally
 * conflicts with node:test's event-loop drain detection.
 *
 * Pathological diff timeout tests live in edit-diff.test.ts.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpuPool } from '../cpu-pool.js'
import {
  diffUnifiedRaw,
  diffStructuredRaw,
  diffLinesRaw,
} from '../cpu-tasks.js'

// ── Inline functions (no pool needed, always work) ──

describe('cpu-tasks (inline)', () => {
  it('diffUnifiedRaw returns a unified diff for a small change', () => {
    const result = diffUnifiedRaw('test.txt', 'a\n', 'b\n', 1000)
    assert.ok(typeof result === 'string')
    assert.ok(result!.includes('--- test.txt'))
    assert.ok(result!.includes('+++ test.txt'))
  })

  it('diffUnifiedRaw handles empty before (new file)', () => {
    const result = diffUnifiedRaw('new.txt', '', 'alpha\nbeta\n', 1000)
    assert.ok(typeof result === 'string')
    assert.ok(result!.includes('+alpha'))
  })

  it('diffStructuredRaw returns hunks for a small change', () => {
    const before = 'one\ntwo\nthree\n'
    const after = 'one\nTWO\nthree\n'
    const patch = diffStructuredRaw(before, after, 1000)
    assert.ok(patch, 'should produce a patch')
    assert.ok(patch!.hunks.length >= 1, 'at least one hunk')
    const hunk = patch!.hunks[0]!
    assert.equal(hunk.newStart, 2, 'change at line 2')
    assert.equal(hunk.newLines, 1, 'one line changed')
  })

  it('diffLinesRaw returns change objects for a small change', () => {
    const changes = diffLinesRaw('a\nb\nc\n', 'a\nB\nc\n', 1000)
    assert.ok(changes, 'should produce changes')
    const added = changes!.filter(c => c.added)
    const removed = changes!.filter(c => c.removed)
    assert.equal(added.length, 1, 'one added line')
    assert.equal(removed.length, 1, 'one removed line')
  })

  it('diffLinesRaw handles identical content', () => {
    const changes = diffLinesRaw('a\nb\nc\n', 'a\nb\nc\n', 1000)
    assert.ok(changes, 'should produce changes')
    // Identical content: all lines are unchanged (no added/removed flags)
    const added = changes!.filter(c => c.added)
    const removed = changes!.filter(c => c.removed)
    assert.equal(added.length, 0, 'no added lines')
    assert.equal(removed.length, 0, 'no removed lines')
  })
})

// ── Pool availability (no worker spawn needed) ──

describe('cpuPool availability', () => {
  it('cpuPool.available reflects RIVET_CPU_POOL setting', () => {
    const disabled = process.env.RIVET_CPU_POOL === '0'
    assert.equal(cpuPool.available, !disabled)
  })
})
