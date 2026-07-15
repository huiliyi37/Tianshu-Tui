import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextInjectionController, type ContextInjectionDeps } from '../context-injection.js'
import { PlaybookStore } from '../playbook-store.js'
import type { PlaybookBullet } from '../playbook.js'

/**
 * Playbook lessons injection. Wave 4（知识重构）起默认撤出推送通道——
 * 只有 env RIVET_PLAYBOOK_INJECT=1 时才恢复注入。恢复态保留历史对策：
 * 每会话只查一次 + minImportance 质量闸，feeds
 * promptEngine.updatePlaybookLessons — which renders via the appendix /
 * consolidated channel and fires onLessonsRendered → recordUsage.
 */

function bullet(overrides: Partial<PlaybookBullet>): PlaybookBullet {
  return {
    id: `b_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    keywords: ['pagination', 'endpoint'],
    lesson: 'verify pagination bounds before shipping',
    context: 'users endpoint task',
    useCount: 0,
    lastUsedAt: null,
    importance: 0.6,
    ...overrides,
  }
}

function makeController(store: PlaybookStore | undefined) {
  const updates: PlaybookBullet[][] = []
  const deps = {
    session: { getTurnCount: () => 0, setContextLedger: () => {} },
    promptEngine: { updatePlaybookLessons: (lessons: PlaybookBullet[]) => { updates.push(lessons) } },
    contextWindow: 128_000,
    getSessionId: () => 's1',
    getTranscriptPath: () => undefined,
    getSessionMemoryState: () => undefined,
    getMessages: () => [],
    getRecentToolHistory: () => [],
    getRepairHintTracker: () => ({ getHint: () => null }),
    getContextClaimStore: () => undefined,
    getPlaybookStore: () => store,
  } as unknown as ContextInjectionDeps
  return { controller: new ContextInjectionController(deps), updates }
}

describe('refreshPlaybookLessons Wave 4 default-off', () => {
  const saved = process.env.RIVET_PLAYBOOK_INJECT
  beforeEach(() => { delete process.env.RIVET_PLAYBOOK_INJECT })
  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_PLAYBOOK_INJECT
    else process.env.RIVET_PLAYBOOK_INJECT = saved
  })

  it('does not inject lessons by default (recall-only channel)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playbook-off-'))
    try {
      const store = new PlaybookStore(join(dir, 'playbook.jsonl'))
      store.save([bullet({ importance: 0.7 })])
      const { controller, updates } = makeController(store)

      controller.refreshPlaybookLessons('add pagination to the posts endpoint')

      assert.equal(updates.length, 0, 'Wave 4: lessons must not enter the prompt push channel by default')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('refreshPlaybookLessons revival (RIVET_PLAYBOOK_INJECT=1)', () => {
  const saved = process.env.RIVET_PLAYBOOK_INJECT
  beforeEach(() => { process.env.RIVET_PLAYBOOK_INJECT = '1' })
  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_PLAYBOOK_INJECT
    else process.env.RIVET_PLAYBOOK_INJECT = saved
  })

  it('queries matching lessons and forwards them to the prompt engine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playbook-revive-'))
    try {
      const store = new PlaybookStore(join(dir, 'playbook.jsonl'))
      store.save([bullet({ importance: 0.7 })])
      const { controller, updates } = makeController(store)

      controller.refreshPlaybookLessons('add pagination to the posts endpoint')

      assert.equal(updates.length, 1)
      assert.equal(updates[0]!.length, 1)
      assert.equal(updates[0]![0]!.lesson, 'verify pagination bounds before shipping')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('filters lessons below the 0.5 importance quality gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playbook-revive-'))
    try {
      const store = new PlaybookStore(join(dir, 'playbook.jsonl'))
      store.save([bullet({ importance: 0.3 })])
      const { controller, updates } = makeController(store)

      controller.refreshPlaybookLessons('add pagination to the posts endpoint')

      assert.equal(updates.length, 0, 'decayed low-importance noise must not be injected')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('queries only once per session — later user inputs do not churn the selection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playbook-revive-'))
    try {
      const store = new PlaybookStore(join(dir, 'playbook.jsonl'))
      store.save([bullet({ importance: 0.7 }), bullet({ keywords: ['css', 'header'], lesson: 'check dark theme too', importance: 0.7 })])
      const { controller, updates } = makeController(store)

      controller.refreshPlaybookLessons('add pagination to the posts endpoint')
      controller.refreshPlaybookLessons('update css styles for the header')

      assert.equal(updates.length, 1, 'session-stable selection — no habituation churn (the original disable reason)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a safe no-op without a playbook store', () => {
    const { controller, updates } = makeController(undefined)
    controller.refreshPlaybookLessons('anything')
    assert.equal(updates.length, 0)
  })
})
