import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { SessionRuntimePool } from '../session-runtime-pool.js'
import { CronScheduler } from '../cron-scheduler.js'
import { buildScheduleRoutes } from '../schedule-routes.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** Agent that emits a summary + a file edit then completes immediately. */
class ScriptedAgent implements ManagedAgent {
  async run(_p: string, cb: AgentCallbacks): Promise<void> {
    cb.onTextDelta('all done')
    cb.onToolUse('tu1', 'edit_file', { path: 'src/x.ts', new_string: 'y' })
    cb.onToolResult('tu1', 'edit_file', 'ok', false)
  }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

test('SessionRuntimePool spawns a VISIBLE session and reports summary + changedFiles', async () => {
  const manager = new RuntimeSessionManager({ createAgent: () => new ScriptedAgent(), defaultCwd: '/work' })
  const pool = new SessionRuntimePool({ manager, defaultCwd: '/work' })

  const handle = await pool.acquire('task-abc12345')
  assert.equal(pool.size, 1)
  const result = await handle.execute('do the thing', new AbortController().signal)
  handle.release()

  assert.equal(pool.size, 0)
  assert.equal(result.summary, 'all done')
  assert.deepEqual(result.changedFiles, ['src/x.ts'])

  // The task ran as a real session the user can see in the Agent Manager.
  const sessions = manager.listSessions()
  assert.equal(sessions.length, 1)
  assert.match(sessions[0]!.title!, /scheduled:task-abc/)
  assert.equal(sessions[0]!.status, 'completed')
})

test('delegation tool events are surfaced as delegation tree nodes', () => {
  const agents: ManagedAgent[] = []
  let cb!: AgentCallbacks
  class DelegatingAgent implements ManagedAgent {
    run(_p: string, callbacks: AgentCallbacks) { cb = callbacks; return new Promise<void>(() => {}) }
    abort(): void {}
    listArtifacts(): Artifact[] { return [] }
    readArtifact(): Promise<string | null> { return Promise.resolve(null) }
    getMessages(): OaiMessage[] { return [] }
    replaceMessages(_msgs: OaiMessage[]): void {}
    rewindToMessages(_msgs: OaiMessage[]): void {}
  }
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new DelegatingAgent(); agents.push(a); return a },
    defaultCwd: '/work',
  })
  const s = manager.createSession({ prompt: 'go' })
  cb.onToolUse('w1', 'delegate_task', { objective: 'search the codebase', profile: 'code_scout' })
  cb.onToolResult('w1', 'delegate_task', 'found 3 hits', false)

  const events = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  assert.equal(events.length, 2)
  assert.equal(events[0]!.data.workerId, 'w1')
  assert.equal(events[0]!.data.objective, 'search the codebase')
  assert.equal(events[0]!.data.status, 'running')
  assert.equal(events[1]!.data.status, 'completed')
})

test('schedule routes: create / list / pause / delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-sched-'))
  try {
    const scheduler = new CronScheduler({ schedulePath: join(dir, 'sched.json') })
    const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))

    const created = await router('POST', '/schedule', {
      prompt: 'nightly review', trigger: { type: 'interval', spec: '3600000' },
    }, AUTH)
    assert.equal(created.status, 201)
    const id = (created.body as { id: string }).id

    const list = await router('GET', '/schedule', {}, AUTH)
    assert.equal((list.body as { tasks: unknown[] }).tasks.length, 1)

    const paused = await router('POST', `/schedule/${id}/pause`, { enabled: false }, AUTH)
    assert.equal(paused.status, 200)
    assert.equal(scheduler.get(id)!.enabled, false)

    const removed = await router('DELETE', `/schedule/${id}`, {}, AUTH)
    assert.equal(removed.status, 200)
    assert.equal(scheduler.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('schedule create validates prompt and trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-sched-'))
  try {
    const scheduler = new CronScheduler({ schedulePath: join(dir, 'sched.json') })
    const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))
    assert.equal((await router('POST', '/schedule', { trigger: { type: 'interval', spec: '1000' } }, AUTH)).status, 400)
    assert.equal((await router('POST', '/schedule', { prompt: 'x' }, AUTH)).status, 400)
    assert.equal((await router('POST', '/schedule', { prompt: 'x', trigger: { type: 'bogus', spec: '1' } }, AUTH)).status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('schedule routes are fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-sched-'))
  try {
    const scheduler = new CronScheduler({ schedulePath: join(dir, 'sched.json') })
    const router = createRouter(buildScheduleRoutes(scheduler, TOKEN))
    assert.equal((await router('GET', '/schedule', {}, {})).status, 401)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
