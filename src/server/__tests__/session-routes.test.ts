import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes, classifyArtifact } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  artifacts: Artifact[] = []
  runPrompts: string[] = []
  activePlanCalls: ({ slug: string; title: string } | null)[] = []
  private resolveRun?: () => void
  run(p: string, cb: AgentCallbacks) { this.runPrompts.push(p); this.callbacks = cb; return new Promise<void>((r) => { this.resolveRun = r }) }
  abort() { this.resolveRun?.() }
  setActivePlan(plan: { slug: string; title: string } | null) { this.activePlanCalls.push(plan) }
  listArtifacts() { return this.artifacts }
  readArtifact(id: string) { return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
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

test('T3: POST /steer queues guidance on a running session', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const res = await router('POST', `/sessions/${id}/steer`, { text: 'prefer tests' }, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { queued: boolean }).queued, true)
})

test('T3: POST /steer on an idle session returns 409', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', {}, AUTH) // idle, no prompt
  const id = (created.body as { id: string }).id
  const res = await router('POST', `/sessions/${id}/steer`, { text: 'hi' }, AUTH)
  assert.equal(res.status, 409)
})

test('T3: POST /steer validates the text field and is Bearer-gated', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  const empty = await router('POST', `/sessions/${id}/steer`, { text: '  ' }, AUTH)
  assert.equal(empty.status, 400)

  const unauth = await router('POST', `/sessions/${id}/steer`, { text: 'x' }, {})
  assert.equal(unauth.status, 401)

  const missing = await router('POST', '/sessions/nope/steer', { text: 'x' }, AUTH)
  assert.equal(missing.status, 404)
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

// ── R3: rollback routes ──────────────────────────────────────────────

test('R3: rollback preview 404 for missing session', async () => {
  const { router } = setup()
  const res = await router('GET', '/sessions/nope/rollback/preview', {}, AUTH)
  assert.equal(res.status, 404)
})

test('R3: rollback preview returns available:false when no checkpoint exists', async () => {
  const { manager, router } = setup()
  // Fresh session in a throwaway cwd → no checkpoint on disk.
  const s = manager.createSession({ cwd: '/tmp/rollback-none-' + Math.random().toString(36).slice(2) })
  const res = await router('GET', `/sessions/${s.id}/rollback/preview`, {}, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { available: boolean }).available, false)
})

test('R3: rollback execute requires a confirmationToken (400)', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({ cwd: '/tmp/rollback-none-' + Math.random().toString(36).slice(2) })
  const res = await router('POST', `/sessions/${s.id}/rollback`, {}, AUTH)
  assert.equal(res.status, 400)
})

test('R3: rollback execute 404 for missing session', async () => {
  const { router } = setup()
  const res = await router('POST', '/sessions/nope/rollback', { confirmationToken: 'x' }, AUTH)
  assert.equal(res.status, 404)
})

test('R3: rollback routes are Bearer-gated (fail-closed)', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({ cwd: '/tmp/work' })
  const preview = await router('GET', `/sessions/${s.id}/rollback/preview`, {}, {})
  assert.equal(preview.status, 401)
  const exec = await router('POST', `/sessions/${s.id}/rollback`, { confirmationToken: 'x' }, {})
  assert.equal(exec.status, 401)
})

// ── S: per-session autonomy routes ──────────────────────────────────

test('S: POST /sessions accepts a valid approvalMode and reflects it on the record', async () => {
  const { router } = setup()
  const res = await router('POST', '/sessions', { approvalMode: 'dangerously-skip-permissions' }, AUTH)
  assert.equal(res.status, 201)
  assert.equal((res.body as { approvalMode?: string }).approvalMode, 'dangerously-skip-permissions')
})

test('S: POST /sessions rejects an invalid approvalMode (400)', async () => {
  const { router } = setup()
  const res = await router('POST', '/sessions', { approvalMode: 'yolo' }, AUTH)
  assert.equal(res.status, 400)
})

test('S: POST /sessions/:id/approval-mode switches the level', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/approval-mode`, { approvalMode: 'manual' }, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { approvalMode: string }).approvalMode, 'manual')
  assert.equal(manager.getSession(s.id)!.approvalMode, 'manual')
})

test('S: approval-mode route validates the body (400) and 404s a missing session', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const bad = await router('POST', `/sessions/${s.id}/approval-mode`, { approvalMode: 'nope' }, AUTH)
  assert.equal(bad.status, 400)
  const missing = await router('POST', '/sessions/nope/approval-mode', { approvalMode: 'manual' }, AUTH)
  assert.equal(missing.status, 404)
})

test('S: approval-mode route is Bearer-gated (fail-closed)', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/approval-mode`, { approvalMode: 'manual' }, {})
  assert.equal(res.status, 401)
})

// ── Plan mode routes ────────────────────────────────────────────────

test('Plan: POST /plan-mode toggles state and 404s a missing session', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const on = await router('POST', `/sessions/${s.id}/plan-mode`, { state: 'planning' }, AUTH)
  assert.equal(on.status, 200)
  assert.equal((on.body as { planMode: string }).planMode, 'planning')
  assert.equal(manager.getSession(s.id)!.planMode, 'planning')

  const bad = await router('POST', `/sessions/${s.id}/plan-mode`, { state: 'nope' }, AUTH)
  assert.equal(bad.status, 400)

  const missing = await router('POST', '/sessions/nope/plan-mode', { state: 'off' }, AUTH)
  assert.equal(missing.status, 404)
})

test('Plan: plan-mode route is Bearer-gated (fail-closed)', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/plan-mode`, { state: 'planning' }, {})
  assert.equal(res.status, 401)
})

test('Plan: GET /plans lists plans (newest first) and 404s a missing session', async () => {
  const { manager, router } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'alpha.md'), '# Alpha Plan\n\nbody', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('GET', `/sessions/${s.id}/plans`, {}, AUTH)
  assert.equal(res.status, 200)
  const plans = (res.body as { plans: Array<{ slug: string; title: string; status: string }> }).plans
  assert.equal(plans.length, 1)
  assert.equal(plans[0]!.slug, 'alpha')
  assert.equal(plans[0]!.title, 'Alpha Plan')
  assert.equal(plans[0]!.status, 'submitted')

  const missing = await router('GET', '/sessions/nope/plans', {}, AUTH)
  assert.equal(missing.status, 404)
})

test('Plan: GET /plans/:slug returns content; 404 for unknown plan', async () => {
  const { manager, router } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'beta.md'), '# Beta\n\ncontent here', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const ok = await router('GET', `/sessions/${s.id}/plans/beta`, {}, AUTH)
  assert.equal(ok.status, 200)
  assert.match((ok.body as { plan: { content: string } }).plan.content, /content here/)

  const gone = await router('GET', `/sessions/${s.id}/plans/ghost`, {}, AUTH)
  assert.equal(gone.status, 404)
})

test('Plan: POST /plans/:slug/approve marks approved and starts a run', async () => {
  const { manager, router, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'gamma.md'), '# Gamma\n\ndo it', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('POST', `/sessions/${s.id}/plans/gamma/approve`, {}, AUTH)
  assert.equal(res.status, 200)
  const after = readFileSync(join(plansDir, 'gamma.md'), 'utf-8')
  assert.match(after, /Status: APPROVED/)
  assert.equal(manager.getSession(s.id)!.planMode, 'off')

  // Pointer injected via setActivePlan (slug/title only — never the body),
  // and the kickoff run is a short one-liner, not the full plan content.
  const agent = agents[0]!
  assert.equal(agent.activePlanCalls.length, 1)
  assert.deepEqual(agent.activePlanCalls[0], { slug: 'gamma', title: 'Gamma' })
  assert.equal(agent.runPrompts.length, 1)
  const kickoff = agent.runPrompts[0]!
  assert.match(kickoff, /Gamma/)
  assert.match(kickoff, /\.rivet\/plans\/gamma\.md/)
  assert.ok(!kickoff.includes('do it'), 'kickoff must not embed the plan body')
})

test('Plan: POST /plans/:slug/reject keeps the file and marks rejected', async () => {
  const { manager, router } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'delta.md'), '# Delta\n\nnope', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('POST', `/sessions/${s.id}/plans/delta/reject`, { comment: 'too vague' }, AUTH)
  assert.equal(res.status, 200)
  const after = readFileSync(join(plansDir, 'delta.md'), 'utf-8')
  assert.match(after, /Status: REJECTED/)
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
