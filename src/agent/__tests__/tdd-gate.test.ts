import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkTddGate, type TddGateInput } from '../tdd-gate.js'

describe('checkTddGate', () => {
  it('returns null when test file already modified', () => {
    const input: TddGateInput = {
      filesRead: new Set(['src/agent/foo.ts']),
      filesModified: new Set(['src/agent/__tests__/foo.test.ts', 'src/agent/foo.ts']),
      isActionable: true,
    }
    assert.equal(checkTddGate(input), null)
  })

  it('returns null when test file already read', () => {
    const input: TddGateInput = {
      filesRead: new Set(['src/agent/__tests__/foo.test.ts']),
      filesModified: new Set(),
      isActionable: true,
    }
    assert.equal(checkTddGate(input), null)
  })

  it('returns warning hint when no test file touched and has source files modified', () => {
    const input: TddGateInput = {
      filesRead: new Set(['src/agent/foo.ts', 'docs/design.md']),
      filesModified: new Set(['src/agent/bar.ts']),
      isActionable: true,
    }
    const result = checkTddGate(input)
    assert.ok(result)
    assert.equal(result.level, 'warning')
    assert.deepEqual(result.signalKinds, ['tdd_violation'])
    assert.ok(result.suggestion.includes('测试'), `suggestion should mention tests in Chinese, got: ${result.suggestion}`)
  })

  it('returns soft hint when only reading source files (no new files created)', () => {
    const input: TddGateInput = {
      filesRead: new Set(['src/agent/foo.ts']),
      filesModified: new Set(),
      isActionable: true,
    }
    const result = checkTddGate(input)
    assert.ok(result)
    assert.equal(result.level, 'warning')
  })

  it('returns null when task is not actionable', () => {
    const input: TddGateInput = {
      filesRead: new Set(),
      filesModified: new Set(['src/agent/bar.ts']),
      isActionable: false,
    }
    assert.equal(checkTddGate(input), null)
  })

  it('recognizes .spec.ts files as test files', () => {
    const input: TddGateInput = {
      filesRead: new Set(['src/agent/foo.spec.ts']),
      filesModified: new Set(['src/agent/bar.ts']),
      isActionable: true,
    }
    assert.equal(checkTddGate(input), null)
  })

  it('recognizes test/ directory files as test files', () => {
    const input: TddGateInput = {
      filesRead: new Set(['test/integration/flow.test.ts']),
      filesModified: new Set(['src/agent/bar.ts']),
      isActionable: true,
    }
    assert.equal(checkTddGate(input), null)
  })
})
