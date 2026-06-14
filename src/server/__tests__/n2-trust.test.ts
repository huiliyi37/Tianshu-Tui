import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { ApprovalResult } from '../../agent/approval-edit.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  prompts: string[] = []
  artifacts: Artifact[] = []
  private resolveRun?: () => void
  run(prompt: string, cb: AgentCallbacks) {
    this.prompts.push(prompt)
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  finish() { this.resolveRun?.() }
  abort() { this.resolveRun?.() }
  listArtifacts() { return this.artifacts }
  readArtifact() { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

test('feedback on an artifact re-injects a structured next-turn prompt', async () => {
  const { manager, agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const agent = agents[0]!

  // Emit an artifact, finish the first turn so the session is idle.
  agent.artifacts = [{
    id: 'edit_file:foo', tool: 'edit_file', target: 'foo.ts', sessionId: id,
    createdAt: 1, summary: 's', sections: [], rawPath: '/tmp/x', charCount: 1, lineCount: 1, sha256: 'h',
  }]
  agent.callbacks!.onToolResult('t1', 'edit_file', 'ok', false)
  agent.finish()
  await new Promise((r) => setTimeout(r, 0))

  const res = await router('POST', `/sessions/${id}/feedback`, { artifactId: 'edit_file:foo', comment: 'add tests' }, AUTH)
  assert.equal(res.status, 200)
  // Same agent (lazy, reused) gets a second run carrying the feedback.
  const fb = agent.prompts[agent.prompts.length - 1]!
  assert.match(fb, /ARTIFACT FEEDBACK/)
  assert.match(fb, /edit_file:foo/)
  assert.match(fb, /foo\.ts/)
  assert.match(fb, /add tests/)
})

test('feedback is rejected (409) while the session is running', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const res = await router('POST', `/sessions/${id}/feedback`, { artifactId: 'a', comment: 'c' }, AUTH)
  assert.equal(res.status, 409)
})

test('feedback requires artifactId and comment (400)', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', {}, AUTH)
  const id = (created.body as { id: string }).id
  const res = await router('POST', `/sessions/${id}/feedback`, { artifactId: 'a' }, AUTH)
  assert.equal(res.status, 400)
})

test('approval answer carries editedInput through to ApprovalResult', async () => {
  const { manager, agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  const pending = agents[0]!.callbacks!.onApprovalRequired(
    'req-1', 'edit_file', { path: 'a.ts', new_string: 'old' },
  )
  const res = await router(
    'POST', `/sessions/${id}/interventions/req-1/answer`,
    { decision: 'approve', editedInput: { path: 'a.ts', new_string: 'EDITED' } }, AUTH,
  )
  assert.equal(res.status, 200)
  const result = (await pending) as ApprovalResult
  assert.equal(result.approved, true)
  assert.deepEqual(result.editedInput, { path: 'a.ts', new_string: 'EDITED' })

  const resolved = manager.getEvents(id, 0)!.events.find((e) => e.type === 'approval_resolved')
  assert.equal(resolved!.data.edited, true)
})

test('intent intervention resolves continue/veto/alternative', async () => {
  const { manager, agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  const pending = agents[0]!.callbacks!.onIntentPreview!({
    summary: 'about to delete', confidence: 0.4, alternatives: ['ask first'], warnings: ['destructive'],
  })
  const reqEvent = manager.getEvents(id, 0)!.events.find((e) => e.type === 'intent_required')!
  const rid = reqEvent.data.requestId as string

  const res = await router('POST', `/sessions/${id}/interventions/${rid}/answer`, { decision: 'veto' }, AUTH)
  assert.equal(res.status, 200)
  assert.equal(await pending, 'veto')
})
