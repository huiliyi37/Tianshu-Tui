import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskContract, advanceContractStatus } from '../../context/task-contract.js'
import { checkTddGate, type TddGateInput } from '../tdd-gate.js'

describe('TDD Gate integration with TaskContract', () => {
  it('fires on planning→executing transition when no tests touched', () => {
    let contract = extractTaskContract('implement immune-apc three-tier gate', 1)
    contract = advanceContractStatus(contract, 'planning', 2)

    // Simulate: agent read source files but no test files
    const evidence: TddGateInput = {
      filesRead: new Set(['src/agent/immune-apc.ts', 'src/agent/immune-types.ts']),
      filesModified: new Set(['src/agent/immune-apc.ts']),
      isActionable: contract.isActionable,
    }

    // Transition to executing
    const prev = contract.status
    contract = advanceContractStatus(contract, 'executing', 3)

    // Gate should fire
    if (prev === 'planning' && contract.status === 'executing') {
      const hint = checkTddGate(evidence)
      assert.ok(hint, 'TDD gate should fire when no test file touched')
      assert.equal(hint.level, 'warning')
    }
  })

  it('does not fire when test file was read before executing', () => {
    let contract = extractTaskContract('implement immune-apc three-tier gate', 1)
    contract = advanceContractStatus(contract, 'planning', 2)

    const evidence: TddGateInput = {
      filesRead: new Set(['src/agent/immune-apc.ts', 'src/agent/__tests__/immune-system.test.ts']),
      filesModified: new Set(),
      isActionable: contract.isActionable,
    }

    const prev = contract.status
    contract = advanceContractStatus(contract, 'executing', 3)

    if (prev === 'planning' && contract.status === 'executing') {
      const hint = checkTddGate(evidence)
      assert.equal(hint, null, 'TDD gate should not fire when test file was read')
    }
  })

  it('does not fire on executing→executing (same status, no transition)', () => {
    let contract = extractTaskContract('fix bug in parser', 1)
    contract = advanceContractStatus(contract, 'executing', 2)

    const prev = contract.status
    contract = advanceContractStatus(contract, 'executing', 3)

    // No transition happened
    assert.equal(prev, 'executing')
    assert.equal(contract.status, 'executing')
    // Gate logic would not be reached because prev === contract.status
  })

  it('does not fire for non-actionable tasks', () => {
    let contract = extractTaskContract('hi', 1)
    assert.equal(contract.isActionable, false)

    const evidence: TddGateInput = {
      filesRead: new Set<string>(),
      filesModified: new Set(['src/agent/foo.ts']),
      isActionable: contract.isActionable,
    }

    const hint = checkTddGate(evidence)
    assert.equal(hint, null)
  })
})
