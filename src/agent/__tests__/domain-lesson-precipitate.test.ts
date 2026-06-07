import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { precipitateDomainLessons } from '../domain-lesson-precipitate.js'
import { buildDomainKnowledgeBlock } from '../domain-knowledge-block.js'
import { DomainKnowledgeStore } from '../domain-knowledge-store.js'
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
  return {
    workOrderId: 'wo_test',
    status: 'passed',
    summary: 'task completed',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

function failedResult(overrides?: Partial<WorkerResult>): WorkerResult {
  return {
    workOrderId: 'wo_test',
    status: 'failed',
    summary: 'test failed: input boundary not checked',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

function blockedResult(summary: string): WorkerResult {
  return {
    workOrderId: 'wo_test',
    status: 'blocked',
    summary,
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'blocked',
  }
}

describe('precipitateDomainLessons', () => {
  test('extracts defect_pattern from failed result', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, {
        domainId: 'tianquan',
        results: [failedResult()],
        objective: 'review input handling',
      })
      assert.ok(count >= 1)
      const lessons = store.recall('tianquan', 10)
      assert.ok(lessons.some(l => l.kind === 'defect_pattern'))
    } finally {
      cleanup()
    }
  })

  test('extracts invariant from examinedFiles', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, {
        domainId: 'tianfu',
        results: [passedResult({
          examinedFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts', 'src/agent/d.ts'],
        })],
        objective: 'find related code',
      })
      assert.ok(count >= 1)
      const lessons = store.recall('tianfu', 10)
      assert.ok(lessons.some(l => l.kind === 'invariant'))
    } finally {
      cleanup()
    }
  })

  test('extracts invariant from changedFiles', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, {
        domainId: 'tianliang',
        results: [passedResult({
          changedFiles: ['src/agent/loop.ts', 'src/tools/edit.ts'],
        })],
        objective: 'implement feature',
      })
      assert.ok(count >= 1)
    } finally {
      cleanup()
    }
  })

  test('extracts adversarial_input from blocked with scope', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, {
        domainId: 'pojun',
        results: [blockedResult('scope file is outside the project')],
        objective: 'explore edge cases',
      })
      assert.ok(count >= 1)
      const lessons = store.recall('pojun', 10)
      assert.ok(lessons.some(l => l.kind === 'adversarial_input'))
    } finally {
      cleanup()
    }
  })

  test('returns 0 for unknown domain', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, {
        domainId: 'nonexistent',
        results: [passedResult()],
        objective: 'test',
      })
      assert.equal(count, 0)
    } finally {
      cleanup()
    }
  })

  test('skips passed result with no extractable patterns', () => {
    const store = makeStore()
    try {
      const count = precipitateDomainLessons(store, {
        domainId: 'tianquan',
        results: [passedResult()], // no examinedFiles, no changedFiles, no verification
        objective: 'simple search',
      })
      assert.equal(count, 0)
    } finally {
      cleanup()
    }
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
      assert.ok(block.includes('的经验'))
    } finally {
      cleanup()
    }
  })

  test('returns empty for unknown domain', () => {
    const store = makeStore()
    try {
      const block = buildDomainKnowledgeBlock(store, 'nonexistent')
      assert.equal(block, '')
    } finally {
      cleanup()
    }
  })

  test('returns empty for domain with no lessons', () => {
    const store = makeStore()
    try {
      const block = buildDomainKnowledgeBlock(store, 'tianquan')
      assert.equal(block, '')
    } finally {
      cleanup()
    }
  })

  test('respects MAX_BLOCK_CHARS', () => {
    const store = makeStore()
    try {
      // Deposit many long lessons
      for (let i = 0; i < 20; i++) {
        store.deposit({
          domainId: 'pojun',
          kind: 'adversarial_input',
          text: `adversarial pattern ${i}: ${'x'.repeat(150)}`,
          evidence: `e${i}`,
        })
      }
      store.flushSync()

      const block = buildDomainKnowledgeBlock(store, 'pojun')
      assert.ok(block.length <= 2200) // some margin for header
    } finally {
      cleanup()
    }
  })
})
