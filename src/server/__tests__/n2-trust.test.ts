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

test('feedback with line-level comments injects [LINE-LEVEL REVIEW] with file:line anchors', async () => {
  const { agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const agent = agents[0]!

  agent.artifacts = [{
    id: 'edit_file:foo', tool: 'edit_file', target: 'foo.ts', sessionId: id,
    createdAt: 1, summary: 's', sections: [], rawPath: '/tmp/x', charCount: 1, lineCount: 1, sha256: 'h',
  }]
  agent.callbacks!.onToolResult('t1', 'edit_file', 'ok', false)
  agent.finish()
  await new Promise((r) => setTimeout(r, 0))

  const res = await router('POST', `/sessions/${id}/feedback`, {
    artifactId: 'edit_file:foo',
    comment: '整体需要补错误处理',
    lines: [
      { file: 'src/foo.ts', oldLine: 41, newLine: 42, comment: '这里漏了 catch' },
      { file: 'src/bar.ts', newLine: 15, comment: '条件判断反了' },
    ],
  }, AUTH)
  assert.equal(res.status, 200)
  const fb = agent.prompts[agent.prompts.length - 1]!
  assert.match(fb, /ARTIFACT FEEDBACK/)
  assert.match(fb, /LINE-LEVEL REVIEW/)
  // 每条行评论带 file:line 锚点
  assert.match(fb, /src\/foo\.ts:42 — 这里漏了 catch/)
  assert.match(fb, /src\/bar\.ts:15 — 条件判断反了/)
})

test('feedback accepts line-only comments with empty artifact comment', async () => {
  const { agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const agent = agents[0]!

  agent.artifacts = [{
    id: 'diff:patch', tool: 'bash', target: 'patch.diff', sessionId: id,
    createdAt: 1, summary: 's', sections: [], rawPath: '/tmp/x', charCount: 1, lineCount: 1, sha256: 'h',
  }]
  agent.callbacks!.onToolResult('t1', 'bash', 'ok', false)
  agent.finish()
  await new Promise((r) => setTimeout(r, 0))

  // 无 artifact 级 comment，只有行级评论 → 应成功（不再是 400）
  const res = await router('POST', `/sessions/${id}/feedback`, {
    artifactId: 'diff:patch',
    comment: '',
    lines: [{ file: 'mod.ts', newLine: 8, comment: '改名后忘改调用方' }],
  }, AUTH)
  assert.equal(res.status, 200)
  const fb = agent.prompts[agent.prompts.length - 1]!
  assert.match(fb, /LINE-LEVEL REVIEW/)
  assert.match(fb, /mod\.ts:8 — 改名后忘改调用方/)
  // 无 artifact 级 comment 时不该出现空的 Comment: 行
  assert.doesNotMatch(fb, /Comment: \n/)
})

test('feedback rejects when both comment and lines are empty (400)', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  // artifactId 有但 comment 空白 + lines 空数组 → 路由层 body 校验 400
  const res = await router('POST', `/sessions/${id}/feedback`, {
    artifactId: 'a',
    comment: '   ',
    lines: [],
  }, AUTH)
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

test('intent note appends a non-blocking timeline event (no pending state)', async () => {
  const { manager, agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  // Fire the non-blocking direction note (fire-and-forget, returns void).
  agents[0]!.callbacks!.onIntentNote!({
    summary: 'about to delete', confidence: 0.4, warnings: ['high commit threshold', 'destructive'],
  })

  const events = manager.getEvents(id, 0)!.events
  const noteEvent = events.find((e) => e.type === 'intent_note')!
  assert.ok(noteEvent, 'intent_note event should be appended')
  assert.equal(noteEvent.data.summary, 'about to delete')
  // 文案翻译：high commit threshold → 大白话
  assert.ok(Array.isArray(noteEvent.data.reasons))
  assert.ok((noteEvent.data.reasons as string[]).some((r) => r.includes('把握偏低')))
  // 非阻塞：intent_note 不携带 requestId（无 pending intervention 可回复）
  assert.equal(noteEvent.data.requestId, undefined)
})
