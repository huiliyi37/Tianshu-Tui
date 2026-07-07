import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditDeliveryClaims, claimAuditEnabled, countFreshVerifications } from '../claim-audit.js'
import type { TaskLedgerEvent } from '../task-ledger.js'

function ev(partial: Partial<TaskLedgerEvent> & { type: TaskLedgerEvent['type']; timestamp: number }): TaskLedgerEvent {
  return { ...partial }
}

test('无宣称文本 → ok', () => {
  const res = auditDeliveryClaims({
    claimText: 'fix: adjust retry backoff for stream errors',
    events: [ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' })],
  })
  assert.equal(res.status, 'ok')
})

test('宣称测试绿 + 零新鲜验证 → block（改完没重跑的全绿是旧绿）', () => {
  const events = [
    ev({ type: 'verification', timestamp: 50, command: 'npm test', status: 'passed' }),
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'feat: done, 全绿', events })
  assert.equal(res.status, 'block')
  assert.ok(res.lines.some(l => l.includes('旧绿')))
})

test('宣称测试绿 + 有新鲜验证 → ok', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'feat: all tests pass', events })
  assert.equal(res.status, 'ok')
})

test('验证与写入同一时间戳 → 算新鲜（>= 语义）', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 100, command: 'npm test', status: 'passed' }),
  ]
  assert.equal(countFreshVerifications(events), 1)
})

test('验证是 failed 状态 → 不算新鲜验证', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'failed' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'fix: 所有测试通过', events })
  assert.equal(res.status, 'block')
})

test('无文件变更的纯报告类交付不拦', () => {
  const events = [
    ev({ type: 'verification', timestamp: 50, command: 'npm test', status: 'passed' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'report: 全绿', events })
  assert.equal(res.status, 'ok')
})

test('验证后的非代码写入（docs/locale）不作废验证新鲜度 → ok', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed' }),
    ev({ type: 'file_write', timestamp: 300, path: 'README.md' }),
    ev({ type: 'file_write', timestamp: 310, path: 'desktop/src/locales/zh-CN/plugins.json' }),
    ev({ type: 'file_write', timestamp: 320, path: 'docs/changelog/entry.md' }),
  ]
  assert.equal(countFreshVerifications(events), 1)
  const res = auditDeliveryClaims({ claimText: 'feat: done, 全绿', events })
  assert.equal(res.status, 'ok')
})

test('验证后改测试文件同样作废旧绿 → block', () => {
  const events = [
    ev({ type: 'verification', timestamp: 100, command: 'npm test', status: 'passed' }),
    ev({ type: 'file_write', timestamp: 200, path: 'src/agent/__tests__/a.test.ts' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'fix: 全绿', events })
  assert.equal(res.status, 'block')
})

test('纯文档交付宣称测试绿且无验证记录 → 不拦（改动影响不到测试）', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'docs/plugins.md' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'docs: update, tests pass', events })
  assert.equal(res.status, 'ok')
})

test('无 path 的 file_write 保守计入代码变更（fail-closed）', () => {
  const events = [
    ev({ type: 'verification', timestamp: 100, command: 'npm test', status: 'passed' }),
    ev({ type: 'file_write', timestamp: 200 }),
  ]
  const res = auditDeliveryClaims({ claimText: 'fix: 全绿', events })
  assert.equal(res.status, 'block')
})

test('宣称 N/N 通过与 ledger 最新验证记录对不上 → warn 不阻断', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed', meta: { passed: 30, failed: 0 } }),
  ]
  const res = auditDeliveryClaims({ claimText: 'feat: 35/35 通过', events })
  assert.equal(res.status, 'warn')
  assert.ok(res.lines.some(l => l.includes('35') && l.includes('30')))
})

test('宣称 N/N 与实际一致 → ok', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed', meta: { passed: 35, failed: 0 } }),
  ]
  const res = auditDeliveryClaims({ claimText: 'feat: 35/35 passed', events })
  assert.equal(res.status, 'ok')
})

test('ledger 验证记录无计数 meta 时不做计数对账', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'feat: 35/35 通过', events })
  assert.equal(res.status, 'ok')
})

// --- 宣称分型对账（审查 2026-07-07 #6）---

test('宣称测试通过但新鲜验证只有 typecheck → block（typecheck 不背书测试宣称）', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npx tsc --noEmit', status: 'passed' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'feat: 所有测试通过', events })
  assert.equal(res.status, 'block')
  assert.ok(res.lines.some(l => l.includes('typecheck')))
})

test('宣称 typecheck 干净但新鲜验证只有测试 → block（测试不背书类型宣称）', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'feat: typecheck 干净', events })
  assert.equal(res.status, 'block')
})

test('同时宣称测试绿 + typecheck 干净，两种验证都有 → ok', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed' }),
    ev({ type: 'verification', timestamp: 210, command: 'npx tsc --noEmit', status: 'passed' }),
  ]
  const res = auditDeliveryClaims({ claimText: 'feat: 全绿，typecheck clean', events })
  assert.equal(res.status, 'ok')
})

test('无法分类的验证命令（make check）两类宣称都认', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'make check', status: 'passed' }),
  ]
  assert.equal(auditDeliveryClaims({ claimText: 'feat: tests pass', events }).status, 'ok')
  assert.equal(auditDeliveryClaims({ claimText: 'feat: typecheck clean', events }).status, 'ok')
})

test('declared kind=lint/build 谁的宣称都不背书', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm run lint', status: 'passed', meta: { kind: 'lint' } }),
  ]
  assert.equal(auditDeliveryClaims({ claimText: 'feat: 全绿', events }).status, 'block')
  assert.equal(auditDeliveryClaims({ claimText: 'feat: typecheck 通过', events }).status, 'block')
})

// --- git 工作树变异作废旧绿（审查 2026-07-07 #7）---

test('验证后 git checkout 还原代码 → 旧验证作废 block', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed' }),
    ev({ type: 'git_action', timestamp: 300, meta: { command: 'git checkout -- src/a.ts' } }),
  ]
  const res = auditDeliveryClaims({ claimText: 'fix: 全绿', events })
  assert.equal(res.status, 'block')
})

test('验证后结构化 git stash_pop → 旧验证作废 block', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed' }),
    ev({ type: 'git_action', timestamp: 300, meta: { command: 'git stash_pop' } }),
  ]
  const res = auditDeliveryClaims({ claimText: 'fix: 全绿', events })
  assert.equal(res.status, 'block')
})

test('验证后只读 git 操作（status/log/commit/checkout -b）不作废旧绿', () => {
  const events = [
    ev({ type: 'file_write', timestamp: 100, path: 'src/a.ts' }),
    ev({ type: 'verification', timestamp: 200, command: 'npm test', status: 'passed' }),
    ev({ type: 'git_action', timestamp: 300, meta: { command: 'git status' } }),
    ev({ type: 'git_action', timestamp: 310, meta: { command: 'git log --oneline -5' } }),
    ev({ type: 'git_action', timestamp: 320, meta: { command: 'deliver_task commit' } }),
    ev({ type: 'git_action', timestamp: 330, meta: { command: 'git checkout -b feat/new-branch' } }),
    ev({ type: 'git_action', timestamp: 340, meta: { command: 'git stash list' } }),
  ]
  const res = auditDeliveryClaims({ claimText: 'fix: 全绿', events })
  assert.equal(res.status, 'ok')
})

test('claimAuditEnabled: RIVET_CLAIM_AUDIT=0 关闭', () => {
  const prev = process.env.RIVET_CLAIM_AUDIT
  try {
    delete process.env.RIVET_CLAIM_AUDIT
    assert.equal(claimAuditEnabled(), true)
    process.env.RIVET_CLAIM_AUDIT = '0'
    assert.equal(claimAuditEnabled(), false)
  } finally {
    if (prev === undefined) delete process.env.RIVET_CLAIM_AUDIT
    else process.env.RIVET_CLAIM_AUDIT = prev
  }
})
