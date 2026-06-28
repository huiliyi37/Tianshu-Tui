import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TDD_GATE_CONFIG, evaluateTddGate } from '../tdd-gate.js'
import type { TddGateState } from '../evidence.js'

// ---------------------------------------------------------------------------
// evaluateTddGate — pure decision function tests
// ---------------------------------------------------------------------------

describe('evaluateTddGate', () => {
  // Helper: build a gate state with sensible defaults.
  const state = (overrides: Partial<TddGateState> = {}): TddGateState => ({
    filesModified: 0,
    verifications: 0,
    editsSinceLastTest: 0,
    hasFailedTests: false,
    ...overrides,
  })

  const enforce = DEFAULT_TDD_GATE_CONFIG // { enabled, mode: "enforce", threshold: 3 }

  // No modifications → allow (the first edit must get through)
  it('allows edit when no files have been modified yet', () => {
    const decision = evaluateTddGate(state({ filesModified: 0 }), 'edit_file', enforce)
    assert.equal(decision.action, 'allow')
    assert.equal(decision.message, undefined)
  })

  // Modified + verified (passing) → allow
  it('allows edit when files are modified but tests already passed', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 2, verifications: 1, hasFailedTests: false }),
      'edit_file',
      enforce,
    )
    assert.equal(decision.action, 'allow')
  })

  // Non-edit tools (read/bash/search) always allowed
  it('allows non-edit tools regardless of gate state', () => {
    const hot = state({ filesModified: 5, verifications: 0, editsSinceLastTest: 10 })
    for (const tool of ['bash', 'read_file', 'grep', 'glob', 'lsp_find_references']) {
      assert.equal(evaluateTddGate(hot, tool, enforce).action, 'allow')
    }
  })

  // Modified, no verification, under threshold → suggest (L1)
  it('suggests (not blocks) when edits are under the block threshold', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 1 }),
      'edit_file',
      enforce,
    )
    assert.equal(decision.action, 'suggest')
    assert.ok(decision.message)
  })

  // Modified, no verification, at/over threshold, enforce → block (L2)
  it('blocks edit in enforce mode when threshold is reached', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 3 }),
      'edit_file',
      enforce,
    )
    assert.equal(decision.action, 'block')
    assert.ok(decision.message?.includes('TDD Gate'))
  })

  // Modified, no verification, at/over threshold, suggest mode → suggest only
  it('only suggests in suggest mode even past the threshold', () => {
    const suggest = { enabled: true, mode: 'suggest' as const, threshold: 3 }
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 5 }),
      'edit_file',
      suggest,
    )
    assert.equal(decision.action, 'suggest')
  })

  // Gate disabled → always allow
  it('allows everything when the gate is disabled', () => {
    const off = { enabled: false, mode: 'enforce' as const, threshold: 3 }
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 99 }),
      'edit_file',
      off,
    )
    assert.equal(decision.action, 'allow')
  })

  // Modified, verified but failed → suggest (nudge to fix tests)
  it('suggests fixing when tests were run but failed', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 2, verifications: 1, hasFailedTests: true }),
      'edit_file',
      enforce,
    )
    assert.equal(decision.action, 'suggest')
    assert.ok(decision.message?.includes('failed'))
  })

  // write_file is also an edit tool
  it('treats write_file as an edit tool', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 3 }),
      'write_file',
      enforce,
    )
    assert.equal(decision.action, 'block')
  })

  // apply_patch is also an edit tool
  it('treats apply_patch as an edit tool', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 3 }),
      'apply_patch',
      enforce,
    )
    assert.equal(decision.action, 'block')
  })

  // hash_edit is also an edit tool
  it('treats hash_edit as an edit tool', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 3 }),
      'hash_edit',
      enforce,
    )
    assert.equal(decision.action, 'block')
  })
})
