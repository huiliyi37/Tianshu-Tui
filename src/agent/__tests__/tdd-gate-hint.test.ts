import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTddGateHint, DEFAULT_TDD_GATE_CONFIG } from '../tdd-gate.js'
import type { TddGateState } from '../evidence.js'
import type { TddGateConfig } from '../tdd-gate.js'

describe('buildTddGateHint', () => {
  const state = (overrides: Partial<TddGateState> = {}): TddGateState => ({
    filesModified: 0,
    verifications: 0,
    editsSinceLastTest: 0,
    hasFailedTests: false,
    hasCodeEdits: false,
    hasReadTestFiles: true,
    ...overrides,
  })

  const enforce: TddGateConfig = DEFAULT_TDD_GATE_CONFIG
  const suggest: TddGateConfig = { enabled: true, mode: 'suggest', threshold: 3, skipIfNoTests: false }

  it('returns null when gate is disabled', () => {
    const off: TddGateConfig = { enabled: false, mode: 'enforce', threshold: 3, skipIfNoTests: false }
    assert.equal(buildTddGateHint(state({ editsSinceLastTest: 5, verifications: 0 }), off), null)
  })

  it('returns null when no files modified', () => {
    assert.equal(buildTddGateHint(state({ filesModified: 0 }), enforce), null)
  })

  it('returns null when verified and passing', () => {
    assert.equal(
      buildTddGateHint(state({ filesModified: 2, verifications: 1, hasFailedTests: false }), enforce),
      null,
    )
  })

  it('returns hint for zero-verification edits with edit count', () => {
    const hint = buildTddGateHint(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 2, hasCodeEdits: true }),
      enforce,
    )
    assert.ok(hint, 'should produce a hint')
    assert.equal(hint!.level, 'warning')
    assert.ok(hint!.signalKinds.includes('tdd_violation'))
    assert.ok(hint!.suggestion.includes('2 edit(s) without a test run'))
  })

  it('returns hint in suggest mode too', () => {
    const hint = buildTddGateHint(
      state({ filesModified: 1, verifications: 0, editsSinceLastTest: 1, hasCodeEdits: true }),
      suggest,
    )
    assert.ok(hint)
    assert.ok(hint!.suggestion.includes('1 edit(s) without a test run'))
  })

  it('returns null when zero edits but zero verifications (filesModified was set externally)', () => {
    // e.g. files were modified before this session, editsSinceLastTest hasn't started yet
    assert.equal(
      buildTddGateHint(state({ filesModified: 1, verifications: 0, editsSinceLastTest: 0, hasCodeEdits: true }), enforce),
      null,
    )
  })

  it('returns hint when tests failed', () => {
    const hint = buildTddGateHint(
      state({ filesModified: 2, verifications: 3, hasFailedTests: true, hasCodeEdits: true }),
      enforce,
    )
    assert.ok(hint)
    assert.ok(hint!.signalKinds.includes('tdd_violation'))
    assert.ok(hint!.suggestion.includes('verification(s) recorded with failures'))
  })
})
