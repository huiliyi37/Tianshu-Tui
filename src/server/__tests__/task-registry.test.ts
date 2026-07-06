/**
 * TaskRegistry + TaskStore 测试
 *
 * 覆盖：
 * - 生命周期完整流转
 * - 状态转换优先级（终态保护）
 * - 去重/幂等
 * - 超时
 * - 取消
 * - TaskStore CRUD
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import {
  JsonTaskStore,
  buildIdempotencyKey,
  canTransition,
  type TaskRecord,
  type TaskStatus,
} from '../task-store.js'
import { TaskRegistry } from '../task-registry.js'
import type { NotifyPolicy } from '../task-registry.js'

const TEST_DIR = '.test-tmp/task-registry-test'

function setupStore(): JsonTaskStore {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  return new JsonTaskStore(TEST_DIR)
}

function setupRegistry(store: JsonTaskStore): TaskRegistry {
  return new TaskRegistry({ taskStore: store })
}

// ─── JsonTaskStore ────────────────────────────────────────────

describe('JsonTaskStore', () => {
  let store: JsonTaskStore

  beforeEach(() => {
    store = setupStore()
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('save and load a task', async () => {
    const record = makeRecord('task_1')
    await store.save(record)
    const loaded = await store.load('task_1')
    assert.ok(loaded)
    assert.equal(loaded!.id, 'task_1')
    assert.equal(loaded!.status, 'pending')
  })

  it('load returns null for missing task', async () => {
    const loaded = await store.load('nonexistent')
    assert.equal(loaded, null)
  })

  it('list returns all tasks sorted by createdAt desc', async () => {
    await store.save(makeRecord('a', '2024-01-01T00:00:00Z'))
    await store.save(makeRecord('b', '2024-06-01T00:00:00Z'))
    await store.save(makeRecord('c', '2024-03-01T00:00:00Z'))

    const list = await store.list()
    assert.equal(list.length, 3)
    assert.equal(list[0]!.id, 'b')
    assert.equal(list[1]!.id, 'c')
    assert.equal(list[2]!.id, 'a')
  })

  it('list filters by status', async () => {
    await store.save(makeRecord('a', undefined, 'pending'))
    await store.save(makeRecord('b', undefined, 'completed'))
    await store.save(makeRecord('c', undefined, 'failed'))

    const active = await store.list({ status: ['pending', 'running'] })
    assert.equal(active.length, 1)
    assert.equal(active[0]!.id, 'a')
  })

  it('list filters by source', async () => {
    await store.save(makeRecord('a', undefined, 'pending', 'api'))
    await store.save(makeRecord('b', undefined, 'pending', 'cron'))

    const apiTasks = await store.list({ source: 'api' })
    assert.equal(apiTasks.length, 1)
    assert.equal(apiTasks[0]!.id, 'a')
  })

  it('delete removes task', async () => {
    await store.save(makeRecord('a'))
    await store.delete('a')
    const loaded = await store.load('a')
    assert.equal(loaded, null)
  })

  it('findActiveByIdempotencyKey returns active task with matching key', async () => {
    await store.save(makeRecord('a', undefined, 'pending', 'api', 'key_abc'))
    await store.save(makeRecord('b', undefined, 'completed', 'api', 'key_abc'))

    const found = await store.findActiveByIdempotencyKey('key_abc')
    assert.ok(found)
    assert.equal(found!.id, 'a')
  })

  it('findActiveByIdempotencyKey returns null if all matching tasks are terminal', async () => {
    await store.save(makeRecord('a', undefined, 'completed', 'api', 'key_abc'))
    const found = await store.findActiveByIdempotencyKey('key_abc')
    assert.equal(found, null)
  })

  it('findActiveByIdempotencyKey index tracks status transitions across saves', async () => {
    await store.save(makeRecord('a', undefined, 'pending', 'api', 'key_abc'))
    assert.ok(await store.findActiveByIdempotencyKey('key_abc'), 'pending → found')

    await store.save({ ...makeRecord('a', undefined, 'running', 'api', 'key_abc') })
    assert.ok(await store.findActiveByIdempotencyKey('key_abc'), 'running → still found')

    await store.save({ ...makeRecord('a', undefined, 'completed', 'api', 'key_abc') })
    assert.equal(await store.findActiveByIdempotencyKey('key_abc'), null, 'terminal → evicted from index')
  })

  it('findActiveByIdempotencyKey index survives delete and sees pre-index disk state', async () => {
    // Save BEFORE the first find builds the index — verifies the initial scan.
    await store.save(makeRecord('a', undefined, 'pending', 'api', 'key_1'))
    await store.save(makeRecord('b', undefined, 'pending', 'api', 'key_2'))

    // A fresh store instance over the same directory (cold cache) must still
    // find the active task via its one-time directory scan.
    const cold = new JsonTaskStore(TEST_DIR)
    const found = await cold.findActiveByIdempotencyKey('key_2')
    assert.ok(found)
    assert.equal(found!.id, 'b')

    await cold.delete('b')
    assert.equal(await cold.findActiveByIdempotencyKey('key_2'), null, 'deleted → no longer found')
    assert.ok(await cold.findActiveByIdempotencyKey('key_1'), 'unrelated key unaffected')
  })

  it('list with limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.save(makeRecord(`task_${i}`, new Date(2024, 0, i + 1).toISOString()))
    }
    const list = await store.list({ limit: 2 })
    assert.equal(list.length, 2)
  })

  it('rejects invalid task ids and never resolves outside the task directory', async () => {
    await assert.rejects(
      () => store.save(makeRecord('../evil')),
      /Invalid task id/,
    )

    assert.equal(await store.load('../evil'), null)
    await store.delete('../evil')
  })

  it('quarantines corrupt per-task JSON instead of clearing the whole table', async () => {
    await store.save(makeRecord('good'))
    writeFileSync(`${TEST_DIR}/bad.json`, '{not-json', 'utf-8')

    const list = await store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.id, 'good')
    assert.ok(readdirSync(TEST_DIR).some(f => f.startsWith('bad.json.corrupt-')))
  })
})

// ─── canTransition ────────────────────────────────────────────

describe('canTransition', () => {
  it('allows pending → any status', () => {
    assert.ok(canTransition('pending', 'running'))
    assert.ok(canTransition('pending', 'completed'))
    assert.ok(canTransition('pending', 'failed'))
    assert.ok(canTransition('pending', 'cancelled'))
    assert.ok(canTransition('pending', 'timed_out'))
  })

  it('allows running → any status', () => {
    assert.ok(canTransition('running', 'completed'))
    assert.ok(canTransition('running', 'failed'))
    assert.ok(canTransition('running', 'cancelled'))
    assert.ok(canTransition('running', 'timed_out'))
  })

  it('prevents completed → lower priority (pending/running)', () => {
    assert.equal(canTransition('completed', 'pending'), false)
    assert.equal(canTransition('completed', 'running'), false)
  })

  it('allows completed → higher priority (failed/timed_out/cancelled)', () => {
    assert.ok(canTransition('completed', 'failed'))
    assert.ok(canTransition('completed', 'timed_out'))
    assert.ok(canTransition('completed', 'cancelled'))
  })

  it('prevents cancelled → anything (highest priority)', () => {
    for (const to of ['pending', 'running', 'completed', 'failed', 'timed_out'] as TaskStatus[]) {
      assert.equal(canTransition('cancelled', to), false, `cancelled → ${to}`)
    }
  })

  it('prevents timed_out → lower priority (completed/failed)', () => {
    assert.equal(canTransition('timed_out', 'completed'), false)
    assert.equal(canTransition('timed_out', 'failed'), false)
  })

  it('allows timed_out → cancelled (higher priority)', () => {
    assert.ok(canTransition('timed_out', 'cancelled'))
  })

  it('allows failed → cancelled/timed_out (higher priority)', () => {
    assert.ok(canTransition('failed', 'cancelled'))
    assert.ok(canTransition('failed', 'timed_out'))
  })

  it('prevents failed → completed (lower priority)', () => {
    assert.equal(canTransition('failed', 'completed'), false)
  })
})

// ─── buildIdempotencyKey ──────────────────────────────────────

describe('buildIdempotencyKey', () => {
  it('same prompt + caller + time bucket produces same key', () => {
    const bucketMs = 5 * 60 * 1000
    const base = Math.floor(Date.now() / bucketMs) * bucketMs + 60_000
    const k1 = buildIdempotencyKey('hello', 'user1', base)
    const k2 = buildIdempotencyKey('hello', 'user1', base + 1_000)
    assert.equal(k1, k2)
  })

  it('different time bucket produces different key', () => {
    const base = Date.now()
    const k1 = buildIdempotencyKey('hello', 'user1', base)
    const k2 = buildIdempotencyKey('hello', 'user1', base + 6 * 60_000)
    assert.notEqual(k1, k2)
  })

  it('different caller produces different key', () => {
    const base = Date.now()
    const k1 = buildIdempotencyKey('hello', 'user1', base)
    const k2 = buildIdempotencyKey('hello', 'user2', base)
    assert.notEqual(k1, k2)
  })

  it('different prompt produces different key', () => {
    const base = Date.now()
    const k1 = buildIdempotencyKey('hello', 'user1', base)
    const k2 = buildIdempotencyKey('world', 'user1', base)
    assert.notEqual(k1, k2)
  })
})

// ─── TaskRegistry ─────────────────────────────────────────────

describe('TaskRegistry', () => {
  let store: JsonTaskStore
  let registry: TaskRegistry

  beforeEach(() => {
    store = setupStore()
    registry = setupRegistry(store)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('creates a task in pending state', async () => {
    const task = await registry.createTask({
      prompt: 'check repo health',
      source: 'api',
    })

    assert.equal(task.status, 'pending')
    assert.equal(task.source, 'api')
    assert.equal(task.prompt, 'check repo health')
    assert.ok(task.id.startsWith('task_'))
    assert.ok(task.createdAt)
  })

  it('deduplicates tasks by idempotency key', async () => {
    const t1 = await registry.createTask({
      prompt: 'check repo health',
      source: 'api',
      callerId: 'user1',
    })
    const t2 = await registry.createTask({
      prompt: 'check repo health',
      source: 'api',
      callerId: 'user1',
    })

    assert.equal(t1.id, t2.id)
  })

  it('force skips dedup and creates new task', async () => {
    const t1 = await registry.createTask({
      prompt: 'check repo health',
      source: 'api',
      callerId: 'user1',
    })
    const t2 = await registry.createTask({
      prompt: 'check repo health',
      source: 'api',
      callerId: 'user1',
      force: true,
    })

    assert.notEqual(t1.id, t2.id)
  })

  it('concurrent createTask with same key produces exactly one task', async () => {
    // H3 真修验证：Promise.all 并发，去重必须生效
    const [t1, t2] = await Promise.all([
      registry.createTask({ prompt: 'concurrent', source: 'api', callerId: 'u1' }),
      registry.createTask({ prompt: 'concurrent', source: 'api', callerId: 'u1' }),
    ])
    assert.equal(t1.id, t2.id, 'concurrent creates must deduplicate')

    // 确认只有一个 task 在存储中
    const all = await registry.listTasks()
    assert.equal(all.length, 1)
  })

  it('concurrent createTask with force creates two tasks', async () => {
    const [t1, t2] = await Promise.all([
      registry.createTask({ prompt: 'concurrent', source: 'api', callerId: 'u1' }),
      registry.createTask({ prompt: 'concurrent', source: 'api', callerId: 'u1', force: true }),
    ])
    assert.notEqual(t1.id, t2.id, 'force must bypass dedup')
  })

  it('transitions pending → running → completed', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual' })
    assert.equal(task.status, 'pending')

    const running = await registry.transition(task.id, 'running')
    assert.equal(running!.status, 'running')
    assert.ok(running!.startedAt)

    const completed = await registry.transition(task.id, 'completed', {
      result: { summary: 'done', changedFiles: [], exitCode: 0 },
    })
    assert.equal(completed!.status, 'completed')
    assert.ok(completed!.completedAt)
    assert.equal(completed!.result!.summary, 'done')
  })

  it('allows completed → failed (higher priority)', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual' })
    await registry.transition(task.id, 'running')
    await registry.transition(task.id, 'completed')

    const failed = await registry.transition(task.id, 'failed')
    assert.equal(failed!.status, 'failed')
  })

  it('allows completed → cancelled (higher priority)', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual' })
    await registry.transition(task.id, 'running')
    await registry.transition(task.id, 'completed')

    const cancelled = await registry.transition(task.id, 'cancelled')
    assert.equal(cancelled!.status, 'cancelled')
  })

  it('prevents cancelled → anything (highest priority)', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual' })
    await registry.transition(task.id, 'cancelled')

    const stillCancelled = await registry.transition(task.id, 'completed')
    assert.equal(stillCancelled!.status, 'cancelled')
  })

  it('cancel calls abort on controller', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual' })
    await registry.transition(task.id, 'running')

    const cancelled = await registry.cancel(task.id)
    assert.equal(cancelled!.status, 'cancelled')
  })

  it('gets task by id', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual' })
    const fetched = await registry.getTask(task.id)
    assert.ok(fetched)
    assert.equal(fetched!.id, task.id)
  })

  it('lists tasks with filter', async () => {
    await registry.createTask({ prompt: 'a', source: 'api', callerId: 'u1' })
    await registry.createTask({ prompt: 'b', source: 'cron', callerId: 'u1' })
    await registry.createTask({ prompt: 'c', source: 'api', callerId: 'u1' })

    const apiTasks = await registry.listTasks({ source: 'api' })
    assert.equal(apiTasks.length, 2)
  })

  it('recoverStaleTasks marks running tasks as timed_out', async () => {
    const t1 = await registry.createTask({ prompt: 'a', source: 'cron' })
    const t2 = await registry.createTask({ prompt: 'b', source: 'api' })
    await registry.transition(t1.id, 'running')
    await registry.transition(t2.id, 'running')

    const recovered = await registry.recoverStaleTasks()
    assert.equal(recovered.length, 2)

    const check1 = await registry.getTask(t1.id)
    const check2 = await registry.getTask(t2.id)
    assert.equal(check1!.status, 'timed_out')
    assert.equal(check2!.status, 'timed_out')
  })

  it('getActiveTasks returns only pending and running', async () => {
    const t1 = await registry.createTask({ prompt: 'a', source: 'api', callerId: 'u1' })
    const t2 = await registry.createTask({ prompt: 'b', source: 'api', callerId: 'u1' })
    const t3 = await registry.createTask({ prompt: 'c', source: 'api', callerId: 'u1' })

    await registry.transition(t1.id, 'running')
    await registry.transition(t3.id, 'completed')

    const active = await registry.getActiveTasks()
    assert.equal(active.length, 2)
    const ids = active.map(r => r.id)
    assert.ok(ids.includes(t1.id))
    assert.ok(ids.includes(t2.id))
  })

  it('configures default timeout per source', async () => {
    const store2 = setupStore()
    const registry2 = new TaskRegistry({
      taskStore: store2,
      defaultTimeoutMs: 1000,
      cronTimeoutMs: 5000,
    })

    const apiTask = await registry2.createTask({ prompt: 'api task', source: 'api' })
    const cronTask = await registry2.createTask({ prompt: 'cron task', source: 'cron' })

    assert.equal(apiTask.timeoutMs, 1000)
    assert.equal(cronTask.timeoutMs, 5000)
  })

  it('emits events on state transitions', async () => {
    const events: Array<{ taskId: string; type: string }> = []
    const store2 = setupStore()
    const registry2 = new TaskRegistry({
      taskStore: store2,
      onEvent: (e) => events.push({ taskId: e.taskId, type: e.type }),
    })

    const task = await registry2.createTask({ prompt: 'test', source: 'manual' })
    assert.ok(events.some(e => e.taskId === task.id && e.type === 'created'))

    await registry2.transition(task.id, 'running')
    assert.ok(events.some(e => e.taskId === task.id && e.type === 'running'))

    await registry2.transition(task.id, 'completed')
    assert.ok(events.some(e => e.taskId === task.id && e.type === 'completed'))
  })

  // ── Notify Policy ──────────────────────────────────────────

  it('silent policy suppresses all events', async () => {
    const events: string[] = []
    const store2 = setupStore()
    const registry2 = new TaskRegistry({
      taskStore: store2,
      notifyPolicy: 'silent',
      onEvent: (e) => events.push(e.type),
    })

    await registry2.createTask({ prompt: 'test', source: 'manual' })
    assert.equal(events.length, 0) // created event suppressed
  })

  it('errors_only policy emits only failed/timed_out events', async () => {
    const events: string[] = []
    const store2 = setupStore()
    const registry2 = new TaskRegistry({
      taskStore: store2,
      notifyPolicy: 'errors_only',
      onEvent: (e) => events.push(e.type),
    })

    const task = await registry2.createTask({ prompt: 'test', source: 'manual' })
    // created event should be suppressed
    assert.equal(events.length, 0)

    await registry2.transition(task.id, 'running')
    // running event should be suppressed
    assert.equal(events.length, 0)

    await registry2.transition(task.id, 'completed')
    // completed event should be suppressed
    assert.equal(events.length, 0)

    // Create another task and fail it
    const task2 = await registry2.createTask({ prompt: 'test2', source: 'manual', force: true })
    await registry2.transition(task2.id, 'failed', { error: 'boom' })

    // failed event should be emitted
    assert.ok(events.includes('failed'))

    // Create another task and time it out
    const task3 = await registry2.createTask({ prompt: 'test3', source: 'manual', force: true })
    await registry2.transition(task3.id, 'timed_out')

    // timed_out event should be emitted
    assert.ok(events.includes('timed_out'))

    // Only error events
    for (const e of events) {
      assert.ok(e === 'failed' || e === 'timed_out')
    }
  })

  it('state_changes policy emits all events', async () => {
    const events: string[] = []
    const store2 = setupStore()
    const registry2 = new TaskRegistry({
      taskStore: store2,
      notifyPolicy: 'state_changes',
      onEvent: (e) => events.push(e.type),
    })

    const task = await registry2.createTask({ prompt: 'test', source: 'manual' })
    assert.ok(events.includes('created'))

    await registry2.transition(task.id, 'running')
    assert.ok(events.includes('running'))

    await registry2.transition(task.id, 'completed')
    assert.ok(events.includes('completed'))
  })

  it('default policy is state_changes when not specified', async () => {
    const events: string[] = []
    const store2 = setupStore()
    const registry2 = new TaskRegistry({
      taskStore: store2,
      onEvent: (e) => events.push(e.type),
    })

    const task = await registry2.createTask({ prompt: 'test', source: 'manual' })
    assert.ok(events.includes('created'))

    await registry2.transition(task.id, 'completed')
    assert.ok(events.includes('completed'))
  })

  it('setNotifyPolicy changes behavior dynamically', async () => {
    const events: string[] = []
    const store2 = setupStore()
    const registry2 = new TaskRegistry({
      taskStore: store2,
      notifyPolicy: 'state_changes',
      onEvent: (e) => events.push(e.type),
    })

    // First task with state_changes
    const t1 = await registry2.createTask({ prompt: 't1', source: 'manual' })
    await registry2.transition(t1.id, 'completed')
    assert.ok(events.includes('completed'))

    // Switch to errors_only
    registry2.setNotifyPolicy('errors_only')
    events.length = 0

    const t2 = await registry2.createTask({ prompt: 't2', source: 'manual', force: true })
    await registry2.transition(t2.id, 'completed')
    // completed suppressed
    assert.equal(events.length, 0)

    const t3 = await registry2.createTask({ prompt: 't3', source: 'manual', force: true })
    await registry2.transition(t3.id, 'failed', { error: 'x' })
    // failed emitted
    assert.ok(events.includes('failed'))

    // Switch to silent
    registry2.setNotifyPolicy('silent')
    events.length = 0

    const t4 = await registry2.createTask({ prompt: 't4', source: 'manual', force: true })
    await registry2.transition(t4.id, 'failed', { error: 'x' })
    // even failed is suppressed in silent mode
    assert.equal(events.length, 0)
  })
})

// ─── Helpers ──────────────────────────────────────────────────

function makeRecord(
  id: string,
  createdAt?: string,
  status: TaskStatus = 'pending',
  source: TaskRecord['source'] = 'api',
  idempotencyKey?: string,
): TaskRecord {
  return {
    id,
    prompt: `prompt for ${id}`,
    source,
    status,
    createdAt: createdAt ?? new Date().toISOString(),
    timeoutMs: 30 * 60 * 1000,
    callerId: 'test',
    idempotencyKey: idempotencyKey ?? `key_${id}`,
    force: false,
  }
}
