import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { serializeUnifiedPlan } from '../../agent/unified-plan.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  artifacts: Artifact[] = []
  running = false
  run(p: string, cb: AgentCallbacks) {
    this.running = true
    this.callbacks = cb
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort() { this.resolveRun?.() }
  setActivePlan(plan: { slug: string; title: string } | null) {}
  listArtifacts() { return this.artifacts }
  readArtifact(id: string) { return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
  private resolveRun?: () => void
}

class CouncilAgent extends FakeAgent {
  conveneCouncil = async (input: { artifactId: string; objective?: string; seats?: { authority: string; charter?: string }[]; rounds?: number }) => {
    return { planMarkdown: `# plan for ${input.artifactId}`, artifactId: 'council:plan:1' }
  }
}

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new CouncilAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

test('POST /sessions/:id/council returns 400 without artifactId', async () => {
  const { router, manager } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/council`, {}, AUTH)
  assert.equal(res.status, 400)
})

test('POST /sessions/:id/council returns 404 for missing session', async () => {
  const { router } = setup()
  const res = await router('POST', '/sessions/nope/council', { artifactId: 'a' }, AUTH)
  assert.equal(res.status, 404)
})

test('POST /sessions/:id/council returns 503 when agent not built', async () => {
  const { router, manager } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/council`, { artifactId: 'a' }, AUTH)
  assert.equal(res.status, 503)
})

test('POST /sessions/:id/council returns 200 when conveneCouncil succeeds', async () => {
  const { router, manager, agents } = setup()
  const s = manager.createSession({ prompt: 'go' })
  await router('GET', `/sessions/${s.id}`, {}, AUTH)
  const agent = agents[0] as CouncilAgent
  agent.artifacts = [{ id: 'plan:1', tool: 'plan_task', target: 'plan.md', sessionId: s.id, createdAt: 1, summary: 's', sections: [], rawPath: '/tmp/x', charCount: 3, lineCount: 1, sha256: 'h' }]
  const res = await router('POST', `/sessions/${s.id}/council`, { artifactId: 'plan:1' }, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { planMarkdown: string }).planMarkdown, '# plan for plan:1')
  assert.equal((res.body as { artifactId: string }).artifactId, 'council:plan:1')
})

test('POST /sessions/:id/council returns 409 when agent reports running', async () => {
  const { router, manager, agents } = setup()
  const s = manager.createSession({ prompt: 'go' })
  const agent = agents[0] as CouncilAgent
  agent.running = true
  // Force the session manager to build the agent reference. In production
  // isRunning() reads AgentLoop._running; in this fake we simulate a busy
  // agent and the implementation's conveneCouncil throws 409.
  agent.conveneCouncil = async () => {
    const err = new Error('Session is already running a turn')
    ;(err as unknown as Record<string, number>).statusCode = 409
    throw err
  }
  manager.getAgentForSession(s.id)
  const res = await router('POST', `/sessions/${s.id}/council`, { artifactId: 'plan:1' }, AUTH)
  assert.equal(res.status, 409)
})

test('POST /sessions/:id/council validates rounds', async () => {
  const { router, manager, agents } = setup()
  const s = manager.createSession({ prompt: 'go' })
  const res = await router('POST', `/sessions/${s.id}/council`, { artifactId: 'plan:1', rounds: 3 }, AUTH)
  assert.equal(res.status, 400)
})

test('POST /sessions/:id/council is Bearer-gated', async () => {
  const { router, manager } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/council`, { artifactId: 'a' }, {})
  assert.equal(res.status, 401)
})
