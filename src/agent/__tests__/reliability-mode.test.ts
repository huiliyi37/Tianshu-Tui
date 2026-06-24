import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isToolAllowedInReliabilityMode, modeForRecoveryTrigger, reliabilityBlockMessage } from '../reliability-mode.js'
import type { RecoveryTriggerResult } from '../recovery-trigger.js'

function trigger(overrides: Partial<RecoveryTriggerResult>): RecoveryTriggerResult {
  return {
    trigger: 'resource_pressure',
    severity: 'warn',
    summary: 'pressure rising',
    evidence: [],
    suggestedActions: [],
    ...overrides,
  }
}

describe('modeForRecoveryTrigger', () => {
  it('returns full when no trigger fires', () => {
    const decision = modeForRecoveryTrigger(null)
    assert.equal(decision.mode, 'full')
  })

  it('maps resource pressure warn to degraded', () => {
    const decision = modeForRecoveryTrigger(trigger({ severity: 'warn', summary: 'resource warn' }))
    assert.equal(decision.mode, 'degraded')
    assert.equal(decision.reason, 'resource warn')
  })

  it('maps resource pressure error to minimal', () => {
    const decision = modeForRecoveryTrigger(trigger({ severity: 'error', summary: 'resource error' }))
    assert.equal(decision.mode, 'minimal')
  })

  it('maps doom loop blocked to degraded', () => {
    const decision = modeForRecoveryTrigger(trigger({ trigger: 'doom_loop_blocked', severity: 'error', summary: 'doom' }))
    assert.equal(decision.mode, 'degraded')
  })

  it('stays at full for doom_loop_blocked when goal is active', () => {
    const decision = modeForRecoveryTrigger(
      trigger({ trigger: 'doom_loop_blocked', severity: 'error', summary: 'doom in goal' }),
      true,
    )
    assert.equal(decision.mode, 'full')
    assert.equal(decision.reason, 'doom in goal')
  })

  it('still degrades on resource pressure error even with goal active', () => {
    const decision = modeForRecoveryTrigger(
      trigger({ severity: 'error', summary: 'resource error' }),
      true,
    )
    assert.equal(decision.mode, 'minimal')
  })

  it('maps context thrashing error to minimal', () => {
    const decision = modeForRecoveryTrigger(trigger({ trigger: 'context_thrashing', severity: 'error', summary: 'thrash' }))
    assert.equal(decision.mode, 'minimal')
  })
})

describe('isToolAllowedInReliabilityMode', () => {
  it('allows all tools in full mode', () => {
    assert.equal(isToolAllowedInReliabilityMode('full', 'write_file', { file_path: 'x' }), true)
  })

  it('blocks write_file and bash writes in degraded mode, but allows edit_file for debug', () => {
    assert.equal(isToolAllowedInReliabilityMode('degraded', 'write_file', { file_path: 'x' }), false)
    assert.equal(isToolAllowedInReliabilityMode('degraded', 'edit_file', { file_path: 'x' }), true)
    assert.equal(isToolAllowedInReliabilityMode('degraded', 'bash', { command: 'echo hi > out.txt' }), false)
  })

  it('allows read-only and verification bash commands in degraded mode', () => {
    assert.equal(isToolAllowedInReliabilityMode('degraded', 'read_file', { file_path: 'x' }), true)
    assert.equal(isToolAllowedInReliabilityMode('degraded', 'bash', { command: 'npm test' }), true)
  })

  it('minimal mode only allows read-only recovery tools', () => {
    assert.equal(isToolAllowedInReliabilityMode('minimal', 'read_file', { file_path: 'x' }), true)
    assert.equal(isToolAllowedInReliabilityMode('minimal', 'grep', { pattern: 'x' }), true)
    assert.equal(isToolAllowedInReliabilityMode('minimal', 'bash', { command: 'npm test' }), false)
    assert.equal(isToolAllowedInReliabilityMode('minimal', 'write_file', { file_path: 'x' }), false)
  })

  it('builds a user-facing block message', () => {
    const decision = modeForRecoveryTrigger(trigger({ severity: 'error', summary: 'resource critical' }))
    const message = reliabilityBlockMessage(decision, 'bash')
    assert.match(message, /minimal/)
    assert.match(message, /resource critical/)
    assert.match(message, /Suggested recovery/)
  })
})
