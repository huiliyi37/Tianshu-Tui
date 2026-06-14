import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes, classifyArtifact } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  artifacts: Artifact[] = []
  private resolveRun?: () => void
  run(_p: string, cb: AgentCallbacks) { this.callbacks = cb; return new Promise<void>((r) => { this.resolveRun = r }) }
  abort() { this.resolveRun?.() }
  listArtifacts() { return this.artifacts }
  readArtifact(id: string) { return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null) }
}

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

test('unauthorized requests are rejected (fail-closed)', async () => {
  const { router } = setup()
  const res = await router('GET', '/sessions', {}, {})
  assert.equal(res.status, 401)
})

test('create + list + get session lifecycle', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { title: 'T' }, AUTH)
  assert.equal(created.status, 201)
  const id = (created.body as { id: string }).id

  const list = await router('GET', '/sessions', {}, AUTH)
  assert.equal((list.body as { sessions: unknown[] }).sessions.length, 1)

  const one = await router('GET', `/sessions/${id}`, {}, AUTH)
  assert.equal(one.status, 200)

  const missing = await router('GET', '/sessions/nope', {}, AUTH)
  assert.equal(missing.status, 404)
})

test('events route reads ?since= from the query string', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  agents[0]!.callbacks!.onTextDelta('one')

  const all = await router('GET', `/sessions/${id}/events?since=0`, {}, AUTH)
  const lastSeq = (all.body as { lastSeq: number }).lastSeq
  assert.ok(lastSeq > 0)

  agents[0]!.callbacks!.onTextDelta('two')
  const tail = await router('GET', `/sessions/${id}/events?since=${lastSeq}`, {}, AUTH)
  const events = (tail.body as { events: Array<{ data: { text: string } }> }).events
  assert.equal(events.length, 1)
  assert.equal(events[0]!.data.text, 'two')
})

test('prompt on a busy session returns 409', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const again = await router('POST', `/sessions/${id}/prompt`, { prompt: 'more' }, AUTH)
  assert.equal(again.status, 409)
})

test('intervention answer route resolves a pending approval', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const pending = agents[0]!.callbacks!.onApprovalRequired('tool-9', 'bash', {})

  const answer = await router(
    'POST', `/sessions/${id}/interventions/tool-9/answer`, { decision: 'approve' }, AUTH,
  )
  assert.equal(answer.status, 200)
  assert.deepEqual(await pending, { approved: true })
})

test('artifacts list + read with taxonomy', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  agents[0]!.artifacts = [{
    id: 'edit_file:1', tool: 'edit_file', target: 'a.ts', sessionId: id, createdAt: 1,
    summary: 's', sections: [], rawPath: '/tmp/x', charCount: 3, lineCount: 1, sha256: 'h',
  }]

  const list = await router('GET', `/sessions/${id}/artifacts`, {}, AUTH)
  const artifacts = (list.body as { artifacts: Array<{ id: string; kind: string }> }).artifacts
  assert.equal(artifacts[0]!.kind, 'diff')

  const read = await router('GET', `/sessions/${id}/artifacts/edit_file:1`, {}, AUTH)
  assert.equal((read.body as { raw: string }).raw, 'raw:edit_file:1')
})

test('classifyArtifact taxonomy mapping', () => {
  const base = { id: 'x', sessionId: 's', createdAt: 0, summary: '', sections: [], rawPath: '', charCount: 0, lineCount: 0, sha256: '' }
  assert.equal(classifyArtifact({ ...base, tool: 'write_plan', target: 'plan.md' }), 'plan')
  assert.equal(classifyArtifact({ ...base, tool: 'todo', target: 'x' }), 'task-list')
  assert.equal(classifyArtifact({ ...base, tool: 'edit_file', target: 'a.ts' }), 'diff')
  assert.equal(classifyArtifact({ ...base, tool: 'bash', target: 'shot.png' }), 'screenshot')
  assert.equal(classifyArtifact({ ...base, tool: 'run_tests', target: 'x' }), 'test-result')
  assert.equal(classifyArtifact({ ...base, tool: 'bash', target: 'ls' }), 'walkthrough')
})
