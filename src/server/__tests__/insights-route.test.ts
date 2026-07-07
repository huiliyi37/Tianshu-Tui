import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { Config } from '../../config/schema.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  artifacts: Artifact[] = []
  runPrompts: string[] = []
  run(_p: string, cb: AgentCallbacks) { this.callbacks = cb; return Promise.resolve() }
  abort() {}
  setActivePlan(_plan: { slug: string; title: string } | null) {}
  listArtifacts() { return this.artifacts }
  readArtifact(id: string) { return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

const config: Config = {
  provider: {
    default: 'deepseek',
    providers: {
      deepseek: {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: [
          {
            id: 'deepseek-v4-pro',
            alias: 'v4-pro',
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            pricing: { input: 1.0, output: 4.0, cacheRead: 0.1, cacheWrite: 1.0 },
          },
        ],
      },
    },
  },
} as unknown as Config

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN, undefined, config))
  return { manager, agents, router }
}

test('GET /sessions/:id/insights aggregates delegation usage and cost', async () => {
  const { agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  const agent = agents[0]
  assert.ok(agent?.callbacks)

  // Simulate main session turns
  agent.callbacks!.onTurnComplete!({ input_tokens: 500_000, output_tokens: 200_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 50_000 }, 1, false)
  agent.callbacks!.onTurnComplete!({ input_tokens: 300_000, output_tokens: 100_000, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 30_000 }, 2, true)

  agent.callbacks!.onDelegationActivity!({
    workOrderId: 'wo-1',
    parentToolId: 'tool-1',
    profile: 'scout',
    status: 'passed',
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      cache_read_input_tokens: 800_000,
      cache_creation_input_tokens: 100_000,
      total_tokens: 1_500_000,
    },
  })

  const res = await router('GET', `/sessions/${id}/insights`, {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as {
    totals: { workers: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; cost: number }
    cacheHitRate: number
    mainSession: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; model?: string; cost: number } | null
    workers: Array<{ workerId: string; cost: number; totalTokens: number }>
    modelBreakdown: Array<{ model: string; cost: number; count: number }>
  }

  // Worker assertions
  assert.equal(body.totals.workers, 1)
  assert.equal(body.workers.length, 1)
  assert.equal(body.workers[0]!.workerId, 'wo-1')
  assert.ok(body.workers[0]!.cost > 0)
  assert.equal(body.modelBreakdown.length, 1)
  assert.equal(body.modelBreakdown[0]!.model, 'deepseek-v4-pro')

  // Main session assertions
  assert.ok(body.mainSession)
  assert.equal(body.mainSession!.inputTokens, 800_000)
  assert.equal(body.mainSession!.outputTokens, 300_000)
  assert.equal(body.mainSession!.cacheReadTokens, 600_000)
  assert.equal(body.mainSession!.cacheWriteTokens, 80_000)
  assert.equal(body.mainSession!.totalTokens, 1_100_000)

  // Totals include main session + worker
  assert.equal(body.totals.inputTokens, 800_000 + 1_000_000)
  assert.equal(body.totals.outputTokens, 300_000 + 500_000)
  assert.equal(body.totals.cacheReadTokens, 600_000 + 800_000)
  assert.equal(body.totals.cacheWriteTokens, 80_000 + 100_000)
  assert.equal(body.totals.totalTokens, 1_100_000 + 1_500_000)
  assert.equal(body.cacheHitRate, 89)
})

test('GET /sessions/:id/insights returns 404 for unknown session', async () => {
  const { router } = setup()
  const res = await router('GET', '/sessions/nope/insights', {}, AUTH)
  assert.equal(res.status, 404)
})
