import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { precipitateDomainLessons } from '../domain-lesson-precipitate.js'
import { buildDomainKnowledgeBlock, formatBatchStigmergyBlock } from '../domain-knowledge-block.js'
import { DomainKnowledgeStore } from '../domain-knowledge-store.js'
import { StigmergyStore } from '../../context/stigmergy.js'
import type { WorkerResult } from '../work-order.js'

const TMP = join(tmpdir(), `rivet-domain-b-test-${Date.now()}`)

function makeStore(): DomainKnowledgeStore {
  mkdirSync(TMP, { recursive: true })
  return new DomainKnowledgeStore(TMP)
}

function cleanup() {
  rmSync(TMP, { recursive: true, force: true })
}

function passedResult(overrides?: Partial<WorkerResult>): WorkerResult {
  return { workOrderId: 'wo_test', status: 'passed', summary: 'task completed', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified', ...overrides }
}

function failedResult(overrides?: Partial<WorkerResult>): WorkerResult {
  return { workOrderId: 'wo_test', status: 'failed', summary: 'test failed: input boundary not checked', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified', ...overrides }
}

function blockedResult(summary: string): WorkerResult {
  return { workOrderId: 'wo_test', status: 'blocked', summary, findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'blocked' }
}

describe('precipitateDomainLessons', () => {
  // ── failed → defect_pattern ──

  test('extracts defect_pattern from failed result', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'tianquan', results: [failedResult()], objective: 'review input handling' })
      assert.ok(count >= 1)
      const lessons = store.recall('tianquan', 10)
      const dp = lessons.find(l => l.kind === 'defect_pattern')
      assert.ok(dp)
      assert.ok(dp!.text.includes('此类任务失败模式:'))
    } finally { cleanup() }
  })

  // ── passed → nothing (generators deleted) ──

  test('passed result produces no lessons (generators deleted)', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'tianfu', results: [passedResult({ examinedFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts', 'src/agent/d.ts'] })], objective: 'find related code' })
      assert.equal(count, 0)
    } finally { cleanup() }
  })

  test('passed result with verification produces nothing', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'tianquan', results: [passedResult({ verification: { command: 'npx tsc --noEmit', status: 'passed', scope: 'full', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 100 } })], objective: 'typecheck' })
      assert.equal(count, 0)
    } finally { cleanup() }
  })

  test('passed result with changedFiles produces nothing', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'tianliang', results: [passedResult({ changedFiles: ['src/agent/loop.ts', 'src/tools/edit.ts'] })], objective: 'implement feature' })
      assert.equal(count, 0)
    } finally { cleanup() }
  })

  // ── blocked → adversarial_input (English signals) ──

  test('blocked with "scope/outside" → 权限/范围限制', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'pojun', results: [blockedResult('scope file is outside the project')], objective: 'explore edge cases' })
      assert.ok(count >= 1)
      const lessons = store.recall('pojun', 10)
      const blocked = lessons.find(l => l.kind === 'adversarial_input')
      assert.ok(blocked)
      assert.ok(blocked!.text.includes('权限/范围限制触发:'))
    } finally { cleanup() }
  })

  test('blocked with "requires approval" → 需人工审批', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'tianfu', results: [blockedResult('operation gated: requires explicit user approval')], objective: 'write config' })
      assert.ok(count >= 1)
      const lessons = store.recall('tianfu', 10)
      const blocked = lessons.find(l => l.kind === 'adversarial_input')
      assert.ok(blocked)
      assert.ok(blocked!.text.includes('需人工审批触发:'))
    } finally { cleanup() }
  })

  test('blocked with "timed out" → 超时/熔断', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'pojun', results: [blockedResult('worker timed out after 120 seconds')], objective: 'deep scan' })
      assert.ok(count >= 1)
      const lessons = store.recall('pojun', 10)
      const blocked = lessons.find(l => l.kind === 'adversarial_input')
      assert.ok(blocked)
      assert.ok(blocked!.text.includes('超时/熔断触发:'))
    } finally { cleanup() }
  })

  // ── blocked → adversarial_input (Chinese signals) ──

  test('Chinese "超出范围权限不足" → 权限/范围限制', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'pojun', results: [blockedResult('操作超出范围，权限不足无法完成')], objective: 'explore edge cases' })
      assert.ok(count >= 1)
      const lessons = store.recall('pojun', 10)
      const blocked = lessons.find(l => l.kind === 'adversarial_input')
      assert.ok(blocked)
      assert.ok(blocked!.text.includes('权限/范围限制触发:'))
    } finally { cleanup() }
  })

  test('Chinese "需要人工审批" → 需人工审批', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'tianfu', results: [blockedResult('该操作需要人工审批才能继续执行')], objective: 'destructive op' })
      assert.ok(count >= 1)
      const lessons = store.recall('tianfu', 10)
      const blocked = lessons.find(l => l.kind === 'adversarial_input')
      assert.ok(blocked)
      assert.ok(blocked!.text.includes('需人工审批触发:'))
    } finally { cleanup() }
  })

  test('Chinese "超时中断" → 超时/熔断', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'pojun', results: [blockedResult('worker 超时中断，任务未完成')], objective: 'long scan' })
      assert.ok(count >= 1)
      const lessons = store.recall('pojun', 10)
      const blocked = lessons.find(l => l.kind === 'adversarial_input')
      assert.ok(blocked)
      assert.ok(blocked!.text.includes('超时/熔断触发:'))
    } finally { cleanup() }
  })

  // ── edge cases ──

  test('"microscope" does not match scope signal (word boundary)', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'pojun', results: [blockedResult('the microscope is broken and needs repair')], objective: 'lab' })
      assert.ok(count >= 1)
      const blocked = store.recall('pojun', 10).find(l => l.kind === 'adversarial_input')
      assert.ok(blocked)
      assert.ok(blocked!.text.startsWith('执行受阻:'))
    } finally { cleanup() }
  })

  test('blocked with short summary produces nothing', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'pojun', results: [blockedResult('err')], objective: 'test' })
      assert.equal(count, 0)
    } finally { cleanup() }
  })

  test('returns 0 for unknown domain', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, { domainId: 'nonexistent', results: [passedResult()], objective: 'test' })
      assert.equal(count, 0)
    } finally { cleanup() }
  })
})

describe('buildDomainKnowledgeBlock', () => {
  test('returns formatted block with lessons', () => {
    const store = makeStore()
    try {
      store.deposit({ domainId: 'tianquan', kind: 'defect_pattern', text: '边界检查缺失', evidence: 'e' })
      store.flushSync()
      const block = buildDomainKnowledgeBlock(store, 'tianquan')
      assert.ok(block.includes('天权'))
      assert.ok(block.includes('边界检查缺失'))
    } finally { cleanup() }
  })

  test('returns empty for unknown domain', () => {
    const store = makeStore()
    try {
      assert.equal(buildDomainKnowledgeBlock(store, 'nonexistent'), '')
    } finally { cleanup() }
  })

  test('returns empty for domain with no lessons', () => {
    const store = makeStore()
    try {
      assert.equal(buildDomainKnowledgeBlock(store, 'tianquan'), '')
    } finally { cleanup() }
  })

  test('respects MAX_BLOCK_CHARS', () => {
    const store = makeStore()
    try {
      for (let i = 0; i < 20; i++) {
        store.deposit({ domainId: 'pojun', kind: 'adversarial_input', text: `adversarial pattern ${i}: ${'x'.repeat(150)}`, evidence: `e${i}` })
      }
      store.flushSync()
      assert.ok(buildDomainKnowledgeBlock(store, 'pojun').length <= 2200)
    } finally { cleanup() }
  })
})

// ── 星河路由记录（收编 #5）：沉淀 → 召回 → 持久化 ──

describe('galaxy routing records', () => {
  test('record + recall by taskShape (newest first)', () => {
    const store = makeStore()
    try {
      store.recordGalaxyRouting({ dimensionName: 'review', authority: 'yaoguang', taskShape: 'review', status: 'passed' })
      store.recordGalaxyRouting({ dimensionName: 'review', authority: 'yaoguang', taskShape: 'review', status: 'failed' })
      store.recordGalaxyRouting({ dimensionName: 'search', authority: 'tianji', taskShape: 'search', status: 'passed' })

      const review = store.recallGalaxyRouting('review')
      // 追加式：两条都在（胜率统计需要多次执行记录）；同毫秒时间戳下
      // 排序不做强断言，只验证内容与去重后的集合
      assert.equal(review.length, 2)
      assert.deepEqual(review.map(r => r.status).sort(), ['failed', 'passed'])
      const search = store.recallGalaxyRouting('search')
      assert.equal(search.length, 1)
      assert.equal(search[0]!.authority, 'tianji')
    } finally { cleanup() }
  })

  test('persists across store instances (flushSync + reload)', () => {
    const store = makeStore()
    try {
      store.recordGalaxyRouting({ dimensionName: 'verify', authority: 'yaoguang', taskShape: 'verify', status: 'passed' })
      store.flushSync()

      const reloaded = new DomainKnowledgeStore(TMP)
      const records = reloaded.recallGalaxyRouting('verify')
      assert.equal(records.length, 1)
      assert.equal(records[0]!.authority, 'yaoguang')
      assert.equal(records[0]!.status, 'passed')
    } finally { cleanup() }
  })

  test('batch record + recall preserves all routing facts', () => {
    const store = makeStore()
    try {
      store.recordGalaxyRoutingBatch([
        { dimensionName: 'review', authority: 'yaoguang', taskShape: 'review', status: 'passed' },
        { dimensionName: 'search', authority: 'tianji', taskShape: 'search', status: 'failed' },
      ])

      assert.equal(store.recallGalaxyRouting('review').length, 1)
      assert.equal(store.recallGalaxyRouting('search')[0]!.status, 'failed')
    } finally { cleanup() }
  })

  test('unknown taskShape recalls nothing', () => {
    const store = makeStore()
    try {
      store.recordGalaxyRouting({ dimensionName: 'plan', authority: 'tianquan', taskShape: 'plan', status: 'passed' })
      assert.equal(store.recallGalaxyRouting('nope').length, 0)
    } finally { cleanup() }
  })
})

// ── 批级共享信息素块（收编 #3）：worker prompt 注入侧 ──

describe('formatBatchStigmergyBlock', () => {
  test('formats top signals by decayed strength, empty store returns empty string', async () => {
    const store = new StigmergyStore(undefined)
    await store.deposit({ path: 'src/a.ts', signal: 'fragile', strength: 0.5 })
    await store.deposit({ path: 'src/b.ts', signal: 'dead-end', strength: 0.9, context: 'recursion' })

    const block = await formatBatchStigmergyBlock(store)
    assert.ok(block.includes('本批共享信号'))
    assert.ok(block.includes('[dead-end] src/b.ts — recursion'), '高强度的 dead-end 应排前')
    assert.ok(block.includes('[fragile] src/a.ts'))

    const empty = await formatBatchStigmergyBlock(new StigmergyStore(undefined))
    assert.equal(empty, '')
  })

  test('caps at 3 signals', async () => {
    const store = new StigmergyStore(undefined)
    for (let i = 0; i < 5; i++) {
      await store.deposit({ path: `src/f${i}.ts`, signal: 'fragile', strength: 0.9 })
    }
    const block = await formatBatchStigmergyBlock(store)
    const matches = block.match(/^\- /gm)?.length ?? 0
    assert.ok(matches <= 3, `最多 3 条，got ${matches}`)
  })
})
