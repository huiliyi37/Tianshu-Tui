/**
 * Task Routes 测试 — Spec B Phase 1 审计 API
 *
 * 覆盖：
 * - GET /tasks（列表 + 过滤）
 * - GET /tasks/:id（单任务详情）
 * - GET /tasks/:id/events（事件流 + since 游标）
 * - 认证（token 检查）
 * - 404 处理
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { createRouter } from '../index.js'
import { buildTaskRoutes } from '../task-routes.js'
import { TaskRegistry } from '../task-registry.js'
import { JsonTaskStore } from '../task-store.js'

const TEST_TASKS_DIR = '.test-tmp/task-routes-test'

function setup() {
  rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
  const store = new JsonTaskStore(TEST_TASKS_DIR)
  const registry = new TaskRegistry({ taskStore: store })
  return { store, registry }
}

describe('Task Routes', () => {
  let registry: TaskRegistry
  let router: ReturnType<typeof createRouter>

  beforeEach(() => {
    const s = setup()
    registry = s.registry
    const taskRoutes = buildTaskRoutes({ registry })
    router = createRouter({ ...taskRoutes })
  })

  afterEach(() => {
    rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
  })

  // ── GET /tasks ────────────────────────────────────────────

  it('GET /tasks returns empty list when no tasks', async () => {
    const res = await router('GET', '/tasks', {})
    assert.equal(res.status, 200)
    const body = res.body as { tasks: unknown[]; count: number }
    assert.deepEqual(body.tasks, [])
    assert.equal(body.count, 0)
  })

  it('GET /tasks returns all tasks', async () => {
    await registry.createTask({ prompt: 'task a', source: 'api', callerId: 'u1' })
    await registry.createTask({ prompt: 'task b', source: 'cron', callerId: 'u1' })

    const res = await router('GET', '/tasks', {})
    assert.equal(res.status, 200)
    const body = res.body as { tasks: unknown[]; count: number }
    assert.equal(body.count, 2)
  })

  it('GET /tasks filters by source', async () => {
    await registry.createTask({ prompt: 'a', source: 'api', callerId: 'u1' })
    await registry.createTask({ prompt: 'b', source: 'cron', callerId: 'u1' })

    const res = await router('GET', '/tasks', { source: 'cron' })
    assert.equal(res.status, 200)
    const body = res.body as { tasks: unknown[]; count: number }
    assert.equal(body.count, 1)
  })

  it('GET /tasks filters by status', async () => {
    const t1 = await registry.createTask({ prompt: 'a', source: 'api', callerId: 'u1' })
    await registry.createTask({ prompt: 'b', source: 'api', callerId: 'u1' })
    await registry.transition(t1.id, 'completed')

    const res = await router('GET', '/tasks', { status: 'completed' })
    assert.equal(res.status, 200)
    const body = res.body as { tasks: unknown[]; count: number }
    assert.equal(body.count, 1)
  })

  // ── GET /tasks/:id ────────────────────────────────────────

  it('GET /tasks/:id returns task details', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual', callerId: 'u1' })

    const res = await router('GET', '/tasks/' + task.id, {})
    assert.equal(res.status, 200)
    const body = res.body as { task: { id: string; prompt: string; status: string } }
    assert.equal(body.task.id, task.id)
    assert.equal(body.task.prompt, 'test')
  })

  it('GET /tasks/:id returns 404 for unknown task', async () => {
    const res = await router('GET', '/tasks/nonexistent', {})
    assert.equal(res.status, 404)
  })

  // ── GET /tasks/:id/events ─────────────────────────────────

  it('GET /tasks/:id/events returns created event after task creation', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual', callerId: 'u1' })

    const res = await router('GET', '/tasks/' + task.id + '/events', {})
    assert.equal(res.status, 200)
    const body = res.body as { events: Array<{ type: string }>; count: number }
    // Task creation triggers a 'created' event via setEventCallback
    assert.ok(body.count >= 1)
    assert.ok(body.events.some(e => e.type === 'created'))
  })

  it('GET /tasks/:id/events returns 404 for unknown task', async () => {
    const res = await router('GET', '/tasks/nonexistent/events', {})
    assert.equal(res.status, 404)
  })

  // ── POST /tasks/:id/cancel ──────────────────────────────

  it('POST /tasks/:id/cancel cancels a running task', async () => {
    const task = await registry.createTask({ prompt: 'to cancel', source: 'api', callerId: 'u1' })
    await registry.transition(task.id, 'running')

    const res = await router('POST', '/tasks/' + task.id + '/cancel', {})
    assert.equal(res.status, 200)
    const body = res.body as { task: { status: string } }
    assert.equal(body.task.status, 'cancelled')
  })

  it('POST /tasks/:id/cancel returns 404 for unknown task', async () => {
    const res = await router('POST', '/tasks/nonexistent/cancel', {})
    assert.equal(res.status, 404)
  })

  // ── Auth ──────────────────────────────────────────────────

  it('returns 401 when token required but not provided', async () => {
    const taskRoutes = buildTaskRoutes({
      registry,
      apiToken: 'secret',
    })
    const authRouter = createRouter({ ...taskRoutes })

    const res = await authRouter('GET', '/tasks', {})
    assert.equal(res.status, 401)
  })

  it('accepts request when correct token provided', async () => {
    const taskRoutes = buildTaskRoutes({
      registry,
      apiToken: 'secret',
    })
    const authRouter = createRouter({ ...taskRoutes })

    await registry.createTask({ prompt: 'test', source: 'api', callerId: 'u1' })

    const res = await authRouter('GET', '/tasks', { token: 'secret' })
    assert.equal(res.status, 200)
  })

  it('rejects wrong token', async () => {
    const taskRoutes = buildTaskRoutes({
      registry,
      apiToken: 'secret',
    })
    const authRouter = createRouter({ ...taskRoutes })

    const res = await authRouter('GET', '/tasks', { token: 'wrong' })
    assert.equal(res.status, 401)
  })
})

// ── Parameterized Router ────────────────────────────────────

describe('Parameterized Router', () => {
  it('matches parameterized routes with params', async () => {
    const routes = {
      'GET /items/:id': (_body: unknown, params?: Record<string, string>) => ({
        status: 200,
        body: { id: params?.id },
      }),
    }
    const router = createRouter(routes)

    const res = await router('GET', '/items/abc123', {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { id: 'abc123' })
  })

  it('falls back to 404 when no match', async () => {
    const routes = {
      'GET /items/:id': () => ({ status: 200, body: {} }),
    }
    const router = createRouter(routes)

    const res = await router('GET', '/unknown', {})
    assert.equal(res.status, 404)
  })

  it('prefers exact match over parameterized', async () => {
    const routes = {
      'GET /items/all': () => ({ status: 200, body: { type: 'exact' } }),
      'GET /items/:id': (_body: unknown, params?: Record<string, string>) => ({
        status: 200,
        body: { type: 'param', id: params?.id },
      }),
    }
    const router = createRouter(routes)

    const res = await router('GET', '/items/all', {})
    assert.deepEqual(res.body, { type: 'exact' })
  })

  it('strips query string before matching', async () => {
    const routes = {
      'GET /search': () => ({ status: 200, body: { matched: true } }),
    }
    const router = createRouter(routes)

    const res = await router('GET', '/search?q=test&limit=10', {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { matched: true })
  })
})
