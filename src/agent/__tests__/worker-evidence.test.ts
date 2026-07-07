import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkerResult } from '../work-order.js'
import type { WorkerTranscript } from '../worker-session.js'
import { verifyWorkerEvidence } from '../worker-evidence.js'

function result(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    workOrderId: 'wo_1',
    status: 'passed',
    summary: 'ok',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

function transcript(toolUses: string[], errors: string[] = [], bashCommands?: string[], failedBashCommands?: string[]): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses,
    toolResults: [],
    errors,
    repairAttempts: 0,
    bashCommands,
    failedBashCommands,
  }
}

test('blocks changed files without verified evidence', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.equal(checked.risks.filter(r => r.includes('unverified')).length, 1)
})

test('blocks self-reported verified result without verification metadata', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('missing verification metadata')))
})

test('fails worker result when verification metadata failed', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: {
      command: 'npm test',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 1,
      failed: 1,
      skipped: 0,
      durationMs: 10,
    },
  }))

  assert.equal(checked.status, 'failed')
  assert.equal(checked.evidenceStatus, 'failed')
})

test('does not duplicate an existing risk', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
    risks: ['unverified: 1 file(s) changed without verified evidence'],
  }))

  assert.equal(checked.risks.filter(r => r.includes('unverified')).length, 1)
})

test('read-only profile skips verification gate when changedFiles is empty', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/auth.ts'],
    evidenceStatus: 'unverified',
  }), 'code_scout')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.deepEqual(checked.examinedFiles, ['src/auth.ts'])
})

test('read-only profile skips verification gate for reviewer', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/config.ts'],
    evidenceStatus: 'unverified',
  }), 'reviewer')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
})

test('passes through read-only worker with examinedFiles and empty changedFiles', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/auth.ts', 'src/login.ts'],
    evidenceStatus: 'unverified',
  }))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.deepEqual(checked.examinedFiles, ['src/auth.ts', 'src/login.ts'])
})

test('downgrades read-only worker self-reported verified to unverified', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/config.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('scan-level only')))
})

test('patcher profile gets advisory risk instead of blocked', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }), 'patcher')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('advisory')))
})

test('verifier profile (old verifier) now blocked instead of advisory', () => {
  // Old verifier is no longer in WRITE_PROFILES_ADVISORY — treated as regular write worker
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }), 'verifier')

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('unverified')))
})

test('adversarial_verifier verified verdict requires run_tests in transcript', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier', transcript(['read_file']))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('without running run_tests')))
})

test('adversarial_verifier verified verdict without transcript is fail-closed', () => {
  // No transcript provided = cannot prove tests were run = downgrade
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('without running run_tests')))
})

test('adversarial_verifier keeps verified verdict when run_tests was actually used', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier', transcript(['read_file', 'run_tests']))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'verified')
  assert.equal(checked.risks.length, 0)
})

test('adversarial_verifier with unchanged evidenceStatus still passes through', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'unverified',
  }), 'adversarial_verifier')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
})

test('goal_judge keeps verified verdict when verification metadata passed', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
    verification: {
      command: 'npm test',
      status: 'passed',
      scope: 'targeted',
      exitCode: 0,
      passed: 5,
      failed: 0,
      skipped: 0,
      durationMs: 100,
    },
  }), 'goal_judge')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'verified')
})

test('goal_judge downgrades verified verdict without passing verification metadata', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'goal_judge')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('without passing verification metadata')))
})

test('adversarial_verifier downgrades verified when run_tests errored', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier', transcript(['read_file', 'run_tests'], ['run_tests: Test run failed']))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('errored')))
})

test('blocks write worker with changedFiles and examinedFiles but no verification', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    examinedFiles: ['src/b.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('missing verification metadata')))
})

// --- 复现即证明泛化（全 profile transcript 取证 + 交付文本宣称扫描）---

test('any profile claiming verified with transcript but no verification run is downgraded', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'implementer', transcript(['read_file', 'edit_file']))

  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('宣称未经复现')))
})

test('verify-shaped bash command in transcript counts as proven verification', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['read_file', 'bash'], [], ['npm test']))

  assert.equal(checked.evidenceStatus, 'verified')
  assert.equal(checked.risks.length, 0)
})

test('non-verify bash (ls/cat) does not count as verification proof', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'implementer', transcript(['bash'], [], ['ls -la', 'cat src/a.ts']))

  assert.equal(checked.evidenceStatus, 'unverified')
})

test('failed verify-shaped bash is not verification proof — verified downgraded', () => {
  // npm test 跑挂了照样宣称 verified 是核心拦截场景：唯一验证证据失败 → 降级。
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['bash'], ['npm test failed: 2 failing'], ['npm test'], ['npm test']))

  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('errored')))
})

test('verify bash failed then retried successfully — verified kept', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['bash', 'bash'], ['npm test failed once'], ['npm test', 'npm test'], ['npm test']))

  assert.equal(checked.evidenceStatus, 'verified')
})

test('run_tests errored but a later verify bash succeeded — verified kept', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['run_tests', 'bash'], ['run_tests: Test run failed'], ['npm test'], []))

  assert.equal(checked.evidenceStatus, 'verified')
})

test('legacy transcript without failedBashCommands treats verify bash as succeeded', () => {
  // 旧序列化固件缺 failedBashCommands——按全部成功处理，不误杀历史数据。
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['bash'], [], ['npm test']))

  assert.equal(checked.evidenceStatus, 'verified')
})

test('non-verifier profile without transcript is not downgraded here (batch re-gate safety)', () => {
  // coordinator 批量聚合二次过闸不带 transcript——首轮已带证据通过的结果
  // 不能在二次过闸被误杀。metadata 门（verification.status）仍然生效。
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer')

  assert.equal(checked.evidenceStatus, 'verified')
})

test('claim language in summary without verification evidence adds 宣称未经复现 risk', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'unverified',
    summary: '修复完成，35/35 全绿，typecheck 干净。',
  }), 'implementer', transcript(['read_file', 'edit_file']))

  assert.ok(checked.risks.some(r => r.includes('宣称未经复现')))
  assert.equal(checked.evidenceStatus, 'unverified')
})

test('claim language backed by real verification passes without extra risk', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'unverified',
    summary: 'All tests pass — 12/12 通过。',
  }), 'implementer', transcript(['run_tests']))

  assert.ok(!checked.risks.some(r => r.includes('宣称未经复现')))
})
