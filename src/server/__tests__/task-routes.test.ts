/**
 * Task Routes 测试 — Spec B Phase 1 审计 API
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildTaskRoutes } from '../task-routes.js'
import { TaskRegistry } from '../task-registry.js'
import { JsonTaskStore } from '../task-store.js'

const TEST_TASKS_DIR = '.test-tmp/task-routes-test'
const TEST_EVENTS_DIR = '.test-tmp/task-routes-events-test'

function setup() {
  rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
  const store = new JsonTaskStore(TEST_TASKS_DIR)
  const registry = new TaskRegistry({ taskStore: store })
  return { store, registry }
}

// Auth headers matching the test token
const H = { authorization: 'Bearer test-token' }

describe('Task Routes', () => {
  let registry: TaskRegistry
  let router: ReturnType<typeof createRouter>

  beforeEach(() => {
    const s = setup()
    registry = s.registry
    rmSync(TEST_EVENTS_DIR, { recursive: true, force: true })
    const taskRoutes = buildTaskRoutes({ registry, apiToken: 'test-token', eventsDir: TEST_EVENTS_DIR })
    router = createRouter({ ...taskRoutes })
  })

  afterEach(() => {
    rmSync(TEST_TASKS_DIR, { recursive: true, force: true })
    rmSync(TEST_EVENTS_DIR, { recursive: true, force: true })
  })

  it('GET /tasks returns empty list', async () => {
    const res = await router('GET', '/tasks', {}, H)
    assert.equal(res.status, 200)
    const body = res.body as { tasks: unknown[]; count: number }
    assert.deepEqual(body.tasks, [])
    assert.equal(body.count, 0)
  })

  it('GET /tasks returns all tasks', async () => {
    await registry.createTask({ prompt: 'task a', source: 'api', callerId: 'u1' })
    await registry.createTask({ prompt: 'task b', source: 'cron', callerId: 'u1' })
    const res = await router('GET', '/tasks', {}, H)
    assert.equal(res.status, 200)
    const body = res.body as { tasks: unknown[]; count: number }
    assert.equal(body.count, 2)
  })

  it('GET /tasks filters by source', async () => {
    await registry.createTask({ prompt: 'a', source: 'api', callerId: 'u1' })
    await registry.createTask({ prompt: 'b', source: 'cron', callerId: 'u1' })
    const res = await router('GET', '/tasks', { source: 'cron' }, H)
    assert.equal(res.status, 200)
    const body = res.body as { tasks: unknown[]; count: number }
    assert.equal(body.count, 1)
  })

  it('GET /tasks filters by status', async () => {
    const t1 = await registry.createTask({ prompt: 'a', source: 'api', callerId: 'u1' })
    await registry.createTask({ prompt: 'b', source: 'api', callerId: 'u1' })
    await registry.transition(t1.id, 'completed')
    const res = await router('GET', '/tasks', { status: 'completed' }, H)
    assert.equal(res.status, 200)
    const body = res.body as { tasks: unknown[]; count: number }
    assert.equal(body.count, 1)
  })

  it('GET /tasks/:id returns task details', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual', callerId: 'u1' })
    const res = await router('GET', '/tasks/' + task.id, {}, H)
    assert.equal(res.status, 200)
    const body = res.body as { task: { id: string } }
    assert.equal(body.task.id, task.id)
  })

  it('GET /tasks/:id returns 404 for unknown', async () => {
    const res = await router('GET', '/tasks/nonexistent', {}, H)
    assert.equal(res.status, 404)
  })

  it('GET /tasks/:id/events returns created event', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual', callerId: 'u1' })
    const res = await router('GET', '/tasks/' + task.id + '/events', {}, H)
    assert.equal(res.status, 200)
    const body = res.body as { events: Array<{ type: string }>; count: number }
    assert.ok(body.count >= 1)
    assert.ok(body.events.some(e => e.type === 'created'))
  })

  it('GET /tasks/:id/events returns 404 for unknown', async () => {
    const res = await router('GET', '/tasks/nonexistent/events', {}, H)
    assert.equal(res.status, 404)
  })

  it('event seq uses durable sidecar and does not reset after a corrupt tail line', async () => {
    const task = await registry.createTask({ prompt: 'test', source: 'manual', callerId: 'u1' })
    const eventPath = join(TEST_EVENTS_DIR, `${task.id}.jsonl`)
    appendFileSync(eventPath, '{bad-json-tail\n', 'utf-8')

    await registry.transition(task.id, 'running')
    const res = await router('GET', '/tasks/' + task.id + '/events', {}, H)

    assert.equal(res.status, 200)
    const body = res.body as { events: Array<{ seq: number; type: string }> }
    const created = body.events.find(e => e.type === 'created')
    const running = body.events.find(e => e.type === 'running')

    assert.ok(created)
    assert.ok(running)
    assert.equal(created!.seq, 1)
    assert.equal(running!.seq, 2)
    assert.equal(readFileSync(join(TEST_EVENTS_DIR, `${task.id}.seq`), 'utf-8').trim(), '2')
  })

  it('POST /tasks/:id/cancel cancels a running task', async () => {
    const task = await registry.createTask({ prompt: 'to cancel', source: 'api', callerId: 'u1' })
    await registry.transition(task.id, 'running')
    const res = await router('POST', '/tasks/' + task.id + '/cancel', {}, H)
    assert.equal(res.status, 200)
    const body = res.body as { task: { status: string } }
    assert.equal(body.task.status, 'cancelled')
  })

  it('POST /tasks/:id/cancel returns 404 for unknown', async () => {
    const res = await router('POST', '/tasks/nonexistent/cancel', {}, H)
    assert.equal(res.status, 404)
  })

  it('returns 401 when token not provided', async () => {
    const taskRoutes = buildTaskRoutes({ registry, apiToken: 'secret', eventsDir: TEST_EVENTS_DIR })
    const authRouter = createRouter({ ...taskRoutes })
    const res = await authRouter('GET', '/tasks', {})
    assert.equal(res.status, 401)
  })

  it('accepts request with correct Bearer token', async () => {
    const taskRoutes = buildTaskRoutes({ registry, apiToken: 'secret', eventsDir: TEST_EVENTS_DIR })
    const authRouter = createRouter({ ...taskRoutes })
    await registry.createTask({ prompt: 'test', source: 'api', callerId: 'u1' })
    const res = await authRouter('GET', '/tasks', {}, { authorization: 'Bearer secret' })
    assert.equal(res.status, 200)
  })

  it('rejects wrong token', async () => {
    const taskRoutes = buildTaskRoutes({ registry, apiToken: 'secret', eventsDir: TEST_EVENTS_DIR })
    const authRouter = createRouter({ ...taskRoutes })
    const res = await authRouter('GET', '/tasks', {}, { authorization: 'Bearer wrong' })
    assert.equal(res.status, 401)
  })
})

describe('Parameterized Router', () => {
  it('matches parameterized routes with params', async () => {
    const routes = {
      'GET /items/:id': (_body: unknown, params?: Record<string, string>) => ({
        status: 200, body: { id: params?.id },
      }),
    }
    const router = createRouter(routes)
    const res = await router('GET', '/items/abc123', {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { id: 'abc123' })
  })

  it('falls back to 404 when no match', async () => {
    const routes = { 'GET /items/:id': () => ({ status: 200, body: {} }) }
    const router = createRouter(routes)
    const res = await router('GET', '/unknown', {})
    assert.equal(res.status, 404)
  })

  it('prefers exact match over parameterized', async () => {
    const routes = {
      'GET /items/all': () => ({ status: 200, body: { type: 'exact' } }),
      'GET /items/:id': (_body: unknown, params?: Record<string, string>) => ({
        status: 200, body: { type: 'param', id: params?.id },
      }),
    }
    const router = createRouter(routes)
    const res = await router('GET', '/items/all', {})
    assert.deepEqual(res.body, { type: 'exact' })
  })

  it('strips query string before matching', async () => {
    const routes = { 'GET /search': () => ({ status: 200, body: { matched: true } }) }
    const router = createRouter(routes)
    const res = await router('GET', '/search?q=test', {})
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { matched: true })
  })
})
