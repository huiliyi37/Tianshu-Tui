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
    hasCodeEdits: false,
    hasReadTestFiles: true,
    ...overrides,
  })

  const enforce = DEFAULT_TDD_GATE_CONFIG // { enabled, mode: "enforce", threshold: 3, skipIfNoTests: false }

  // No modifications → allow (the first edit must get through)
  it('allows edit when no files have been modified yet', () => {
    const decision = evaluateTddGate(state({ filesModified: 0 }), 'edit_file', enforce)
    assert.equal(decision.action, 'allow')
    assert.equal(decision.message, undefined)
  })

  // Modified + verified (passing) → allow
  it('allows edit when files are modified but tests already passed', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 2, verifications: 1, hasFailedTests: false, hasCodeEdits: true }),
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
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 1, hasCodeEdits: true }),
      'edit_file',
      enforce,
    )
    assert.equal(decision.action, 'suggest')
    assert.ok(decision.message)
  })

  // Modified, no verification, at/over threshold, enforce → block (L2)
  it('blocks edit in enforce mode when threshold is reached', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 3, hasCodeEdits: true }),
      'edit_file',
      enforce,
    )
    assert.equal(decision.action, 'block')
    assert.ok(decision.message?.includes('TDD Gate'))
  })

  // Modified, no verification, at/over threshold, suggest mode → suggest only
  it('only suggests in suggest mode even past the threshold', () => {
    const suggest = { enabled: true, mode: 'suggest' as const, threshold: 3, skipIfNoTests: false }
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 5, hasCodeEdits: true }),
      'edit_file',
      suggest,
    )
    assert.equal(decision.action, 'suggest')
  })

  // skipIfNoTests: no test files read → downgrade block to suggest
  it('downgrades block to suggest when skipIfNoTests and no test files read', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 5, hasCodeEdits: true, hasReadTestFiles: false }),
      'edit_file',
      enforce, // default has skipIfNoTests: true
    )
    assert.equal(decision.action, 'suggest')
  })

  // skipIfNoTests: test files exist → still blocks
  it('still blocks when skipIfNoTests but test files have been read', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 5, hasCodeEdits: true, hasReadTestFiles: true }),
      'edit_file',
      enforce,
    )
    assert.equal(decision.action, 'block')
  })

  // Gate disabled → always allow
  it('allows everything when the gate is disabled', () => {
    const off = { enabled: false, mode: 'enforce' as const, threshold: 3, skipIfNoTests: false }
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
      state({ filesModified: 2, verifications: 1, hasFailedTests: true, hasCodeEdits: true }),
      'edit_file',
      enforce,
    )
    assert.equal(decision.action, 'suggest')
    assert.ok(decision.message?.includes('failed'))
  })

  // write_file is also an edit tool
  it('treats write_file as an edit tool', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 3, hasCodeEdits: true }),
      'write_file',
      enforce,
    )
    assert.equal(decision.action, 'block')
  })

  // apply_patch is also an edit tool
  it('treats apply_patch as an edit tool', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 3, hasCodeEdits: true }),
      'apply_patch',
      enforce,
    )
    assert.equal(decision.action, 'block')
  })

  // hash_edit is also an edit tool
  it('treats hash_edit as an edit tool', () => {
    const decision = evaluateTddGate(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 3, hasCodeEdits: true }),
      'hash_edit',
      enforce,
    )
    assert.equal(decision.action, 'block')
  })

  // ── Doc-only edits: no code files modified → always allow ──

  it('allows doc-only edits even past the threshold (hasCodeEdits: false)', () => {
    const docOnly = state({
      filesModified: 5,
      verifications: 0,
      editsSinceLastTest: 10,
      hasCodeEdits: false,
    })
    assert.equal(evaluateTddGate(docOnly, 'edit_file', enforce).action, 'allow')
    assert.equal(evaluateTddGate(docOnly, 'write_file', enforce).action, 'allow')
    assert.equal(evaluateTddGate(docOnly, 'hash_edit', enforce).action, 'allow')
    assert.equal(evaluateTddGate(docOnly, 'apply_patch', enforce).action, 'allow')
  })

  it('blocks code edits when hasCodeEdits is true and threshold is reached', () => {
    const codeEdit = state({
      filesModified: 3,
      verifications: 0,
      editsSinceLastTest: 5,
      hasCodeEdits: true,
    })
    assert.equal(evaluateTddGate(codeEdit, 'edit_file', enforce).action, 'block')
  })

  it('suggests code edits when hasCodeEdits is true but under threshold', () => {
    const codeEdit = state({
      filesModified: 1,
      verifications: 0,
      editsSinceLastTest: 2,
      hasCodeEdits: true,
    })
    assert.equal(evaluateTddGate(codeEdit, 'edit_file', enforce).action, 'suggest')
  })

  // ── Mixed: both code and doc edits → code edits gate normally ──

  it('gates code edits normally even when docs were also edited (hasCodeEdits: true)', () => {
    const mixed = state({
      filesModified: 5, // mix of .md + .ts
      verifications: 0,
      editsSinceLastTest: 3,
      hasCodeEdits: true,
    })
    assert.equal(evaluateTddGate(mixed, 'edit_file', enforce).action, 'block')
  })
})
