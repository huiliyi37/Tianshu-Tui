import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isScratchScopedWrite, isToolAllowedInReliabilityMode, modeForRecoveryTrigger, reliabilityBlockMessage } from '../reliability-mode.js'
import type { RecoveryTrigger, RecoveryTriggerResult } from '../recovery-trigger.js'

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

  it('caps recurring error triggers at degraded (one-shot suppression)', () => {
    const suppressed = new Set<RecoveryTrigger>(['session_integrity'])
    const decision = modeForRecoveryTrigger(
      trigger({ trigger: 'session_integrity', severity: 'error', summary: 'orphan tools' }),
      false,
      suppressed,
    )
    assert.equal(decision.mode, 'degraded')
    assert.match(decision.reason, /capped at degraded/)
  })

  it('does not suppress different triggers', () => {
    const suppressed = new Set<RecoveryTrigger>(['session_integrity'])
    const decision = modeForRecoveryTrigger(
      trigger({ trigger: 'resource_pressure', severity: 'error', summary: 'oom' }),
      false,
      suppressed,
    )
    assert.equal(decision.mode, 'minimal')
    assert.match(decision.reason, /oom/)
  })

  it('does not cap warn-severity triggers', () => {
    const suppressed = new Set<RecoveryTrigger>(['resource_pressure'])
    const decision = modeForRecoveryTrigger(
      trigger({ trigger: 'resource_pressure', severity: 'warn', summary: 'pressure' }),
      false,
      suppressed,
    )
    assert.equal(decision.mode, 'degraded')
    assert.match(decision.reason, /pressure/)
  })

  it('first-time error trigger is NOT suppressed (empty set)', () => {
    const suppressed = new Set<RecoveryTrigger>()
    const decision = modeForRecoveryTrigger(
      trigger({ trigger: 'session_integrity', severity: 'error', summary: 'orphan tools' }),
      false,
      suppressed,
    )
    assert.equal(decision.mode, 'minimal')
  })

  it('AgentLoop ordering: first occurrence → minimal, second → degraded', () => {
    const suppressed = new Set<RecoveryTrigger>()
    const first = modeForRecoveryTrigger(
      trigger({ trigger: 'session_integrity', severity: 'error', summary: 'orphan tools' }),
      false,
      suppressed,
    )
    assert.equal(first.mode, 'minimal')
    suppressed.add('session_integrity')
    const second = modeForRecoveryTrigger(
      trigger({ trigger: 'session_integrity', severity: 'error', summary: 'orphan tools (recurring)' }),
      false,
      suppressed,
    )
    assert.equal(second.mode, 'degraded')
    assert.match(second.reason, /capped at degraded/)
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
    assert.match(message, /RIVET_RELIABILITY_OVERRIDE/)
  })

  it('allows scratch-scoped write_file in degraded mode (self-rescue escape hatch)', () => {
    const tmpFile = join(tmpdir(), 'rivet-scratch-probe.txt')
    assert.equal(isToolAllowedInReliabilityMode('degraded', 'write_file', { file_path: tmpFile }), true)
    assert.equal(isToolAllowedInReliabilityMode('degraded', 'write_file', { file_path: '/work/project/.rivet/scratch/out.txt' }), true)
    // Non-scratch workspace writes stay blocked.
    assert.equal(isToolAllowedInReliabilityMode('degraded', 'write_file', { file_path: '/work/project/src/index.ts' }), false)
  })

  it('allows scratch-scoped writes even in minimal mode (last-resort self-rescue)', () => {
    const tmpFile = join(tmpdir(), 'rivet-scratch-probe.txt')
    assert.equal(isToolAllowedInReliabilityMode('minimal', 'write_file', { file_path: tmpFile }), true)
    assert.equal(isToolAllowedInReliabilityMode('minimal', 'write_file', { file_path: '/work/project/.rivet/scratch/out.txt' }), true)
    // Non-scratch workspace writes stay blocked even in minimal mode.
    assert.equal(isToolAllowedInReliabilityMode('minimal', 'write_file', { file_path: '/work/project/src/index.ts' }), false)
  })

  it('minimal block message advertises scratch self-rescue and env var override', () => {
    const decision = modeForRecoveryTrigger(trigger({ severity: 'error', summary: 'resource critical' }))
    const message = reliabilityBlockMessage(decision, 'bash')
    assert.match(message, /minimal/)
    assert.match(message, /resource critical/)
    assert.match(message, /scratch/)
    assert.match(message, /RIVET_RELIABILITY_OVERRIDE/)
  })

  it('degraded block message advertises the scratch self-rescue path', () => {
    const decision = modeForRecoveryTrigger(trigger({ trigger: 'doom_loop_blocked', severity: 'error', summary: 'doom' }))
    const message = reliabilityBlockMessage(decision, 'write_file')
    assert.match(message, /scratch/)
  })
})

describe('isScratchScopedWrite', () => {
  it('recognises temp dir and .rivet/scratch targets', () => {
    assert.equal(isScratchScopedWrite('write_file', { file_path: join(tmpdir(), 'x.txt') }), true)
    assert.equal(isScratchScopedWrite('write_file', { file_path: '/a/b/.rivet/scratch/y.txt' }), true)
    assert.equal(isScratchScopedWrite('write_file', { path: join(tmpdir(), 'z.txt') }), true)
  })

  it('rejects non-scratch writes and non-write tools', () => {
    assert.equal(isScratchScopedWrite('write_file', { file_path: '/a/b/src/index.ts' }), false)
    assert.equal(isScratchScopedWrite('write_file', {}), false)
    assert.equal(isScratchScopedWrite('bash', { command: 'echo hi > /tmp/x' }), false)
  })

  it('does not treat a sibling dir like .rivet/scratchpad as scratch', () => {
    assert.equal(isScratchScopedWrite('write_file', { file_path: '/a/.rivet/scratchpad/x' }), false)
  })
})
