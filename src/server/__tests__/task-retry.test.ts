/**
 * M3 automation reliability: bounded retry, session-terminal-status propagation
 * (a failed run must NOT be recorded as completed), and ScheduledTask linkage.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, mkdirSync } from 'node:fs'
import { JsonTaskStore } from '../task-store.js'
import { TaskRegistry, type RuntimePool, type RuntimeHandle } from '../task-registry.js'
import { SessionRuntimePool } from '../session-runtime-pool.js'
import type { RuntimeSessionManager } from '../session-manager.js'

const TEST_DIR = '.test-tmp/task-retry-test'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Pool whose handle records execution and can be told to fail. */
class FakePool implements RuntimePool {
  size = 0
  executed: string[] = []
  constructor(private readonly behavior: (taskId: string) => 'ok' | 'fail') {}
  acquire(taskId: string): Promise<RuntimeHandle> {
    return Promise.resolve({
      execute: async (_prompt, _signal, _tools, onSessionStart) => {
        onSessionStart?.(`sess-${taskId}`)
        this.executed.push(taskId)
        if (this.behavior(taskId) === 'fail') throw new Error('boom')
        return { summary: 'done', changedFiles: [] }
      },
      release: () => { this.size = Math.max(0, this.size - 1) },
    })
  }
}

describe('TaskRegistry retry + linkage', () => {
  let store: JsonTaskStore
  let registry: TaskRegistry

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    store = new JsonTaskStore(TEST_DIR)
  })

  afterEach(() => {
    registry?.dispose()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('retries a failed task up to maxAttempts, linking retryOf + scheduledTaskId', async () => {
    const pool = new FakePool(() => 'fail')
    registry = new TaskRegistry({ taskStore: store, runtimePool: pool })

    await registry.createTask({
      prompt: 'p',
      source: 'cron',
      scheduledTaskId: 'cron_abc',
      retry: { maxAttempts: 2, backoffMs: 1 },
    })

    await delay(120)

    const all = await registry.listTasks()
    // First attempt + one retry = 2 records, both failed, both linked to cron_abc.
    assert.equal(all.length, 2)
    assert.ok(all.every((t) => t.status === 'failed'))
    assert.ok(all.every((t) => t.scheduledTaskId === 'cron_abc'))

    const attempts = all.map((t) => t.attempt).sort()
    assert.deepEqual(attempts, [1, 2])
    const retryRec = all.find((t) => t.attempt === 2)!
    assert.ok(retryRec.retryOf, 'retry record points back to the original task')

    const scoped = await registry.listTasks({ scheduledTaskId: 'cron_abc' })
    assert.equal(scoped.length, 2)
  })

  it('does not retry when no retry policy is set', async () => {
    const pool = new FakePool(() => 'fail')
    registry = new TaskRegistry({ taskStore: store, runtimePool: pool })
    await registry.createTask({ prompt: 'p', source: 'cron' })
    await delay(80)
    const all = await registry.listTasks()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.status, 'failed')
  })

  it('records sessionId even for failed runs, and completed for success', async () => {
    const okPool = new FakePool(() => 'ok')
    registry = new TaskRegistry({ taskStore: store, runtimePool: okPool })
    const t = await registry.createTask({ prompt: 'p', source: 'api' })
    await delay(80)
    const done = await registry.getTask(t.id)
    assert.equal(done!.status, 'completed')
    assert.equal(done!.sessionId, `sess-${t.id}`)
    assert.equal(done!.attempt, 1)
  })
})

describe('SessionRuntimePool status propagation', () => {
  function fakeManager(status: string): RuntimeSessionManager {
    return {
      createSession: () => ({ id: 'sess-1' }),
      abort: () => {},
      runAndWait: async () => ({ status, summary: 'sum', changedFiles: ['a.ts'] }),
    } as unknown as RuntimeSessionManager
  }

  it('throws when the session terminates failed (so registry marks failed, not completed)', async () => {
    const pool = new SessionRuntimePool({ manager: fakeManager('failed'), defaultCwd: '/tmp' })
    const handle = await pool.acquire('task_x')
    await assert.rejects(() => handle.execute('p', new AbortController().signal))
  })

  it('throws when the session is aborted', async () => {
    const pool = new SessionRuntimePool({ manager: fakeManager('aborted'), defaultCwd: '/tmp' })
    const handle = await pool.acquire('task_x')
    await assert.rejects(() => handle.execute('p', new AbortController().signal))
  })

  it('resolves + reports the session id on success', async () => {
    const pool = new SessionRuntimePool({ manager: fakeManager('completed'), defaultCwd: '/tmp' })
    const handle = await pool.acquire('task_x')
    let reported: string | undefined
    const res = await handle.execute('p', new AbortController().signal, undefined, (sid) => { reported = sid })
    assert.equal(res.summary, 'sum')
    assert.deepEqual(res.changedFiles, ['a.ts'])
    assert.equal(reported, 'sess-1')
  })
})
