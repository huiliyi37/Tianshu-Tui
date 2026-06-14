/**
 * Rewind feature tests — covers RuntimeSessionManager.listRewindPoints + rewind,
 * plus session-routes GET /rewind-points + POST /rewind.
 *
 * Anti-proof table (each test would FAIL against a specific lazy implementation):
 *   #1 "only truncates events, no rewind marker" → test 4 checks for type=rewind event
 *   #2 "replaceMessages without checking running" → test 3 verifies running is rejected
 *   #3 "rewind doesn't actually truncate messages" → test 2 verifies message count after rewind
 *   #4 "listRewindPoints returns all messages" → test 1 verifies only user+string entries returned
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import { SessionContext } from '../../agent/context.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** Agent with a real in-memory message store for testing rewind. */
class RewindableAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  messages: OaiMessage[] = []
  artifacts: Artifact[] = []
  private resolveRun?: () => void

  run(_prompt: string, cb: AgentCallbacks): Promise<void> {
    this.callbacks = cb
    // Immediately resolve so session returns to idle right away.
    return Promise.resolve()
  }
  finish(): void { this.resolveRun?.() }
  abort(): void { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return this.artifacts }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(msgs: OaiMessage[]): void { this.messages = msgs }
}

function makeMessages(): OaiMessage[] {
  return [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'Do task A' },
    { role: 'assistant', content: 'Doing A' },
    { role: 'user', content: 'Now do B' },
    { role: 'assistant', content: 'Doing B' },
  ]
}

function setup() {
  const agents: RewindableAgent[] = []
  const manager = new RuntimeSessionManager({
    // Sync agent: resolves run immediately → session returns to idle at once.
    createAgent: () => {
      const a = new RewindableAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  const router = createRouter(routes)
  return { manager, router, agents }
}

/** Create a session with messages populated, in idle state. */
async function makeSession(manager: RuntimeSessionManager, agents: RewindableAgent[]): Promise<string> {
  const s = manager.createSession({ prompt: 'init' })
  // Wait for the auto-run to settle (RewindableAgent resolves immediately)
  await new Promise(r => setTimeout(r, 10))
  agents[agents.length - 1]!.messages = makeMessages()
  return s.id
}

test('#1 listRewindPoints returns only user messages with string content', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  const points = manager.listRewindPoints(id)!
  assert.equal(points.length, 3, 'should find 3 user messages')
  assert.equal(points[0]!.content, 'Hello')
  assert.equal(points[1]!.content, 'Do task A')
  assert.equal(points[2]!.content, 'Now do B')
  // Indices must match the message array positions
  assert.equal(points[0]!.index, 0)
  assert.equal(points[1]!.index, 2)
  assert.equal(points[2]!.index, 4)
})

test('#2 rewind truncates messages to the selected index', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  // Rewind to index 2 ("Do task A") — keeps messages 0..1, drops the rest
  const ok = manager.rewind(id, 2)
  assert.ok(ok, 'rewind should succeed')

  const msgs = agents[agents.length - 1]!.messages
  assert.equal(msgs.length, 2, 'should have truncated to 2 messages')
  assert.equal(msgs[0]!.role, 'user')
  assert.equal((msgs[0] as { content: string }).content, 'Hello')
  assert.equal(msgs[1]!.role, 'assistant')
})

test('#3 rewind is rejected while session is running', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  // Start a new run (don't wait — session stays running)
  manager.run(id, 'another prompt')

  const ok = manager.rewind(id, 2)
  assert.equal(ok, false, 'rewind must be rejected while running')
  // Messages should NOT have been modified
  assert.equal(agents[agents.length - 1]!.messages.length, 6, 'messages must be untouched')
})

test('#4 rewind appends a rewind event to the event log (append-only)', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  manager.rewind(id, 2)

  const result = manager.getEvents(id, 0)!
  const rewindEvent = result.events.find((e) => e.type === 'rewind')
  assert.ok(rewindEvent, 'event log must contain a rewind event')
  assert.equal(rewindEvent!.data.messageIndex, 2)
  assert.equal(rewindEvent!.data.prompt, 'Do task A')
})

test('#5 rewind with invalid index returns false', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  assert.equal(manager.rewind(id, -1), false, 'negative index rejected')
  assert.equal(manager.rewind(id, 999), false, 'out-of-range index rejected')
  assert.equal(manager.rewind(id, 6), false, 'index == length rejected')
})

test('#6 GET /sessions/:id/rewind-points returns points via HTTP route', async () => {
  const { manager, router, agents } = setup()
  const id = await makeSession(manager, agents)

  const res = await router('GET', `/sessions/${id}/rewind-points`, {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as { points: { index: number; content: string }[] }
  assert.equal(body.points.length, 3)
  assert.equal(body.points[1]!.content, 'Do task A')
})

test('#7 POST /sessions/:id/rewind truncates via HTTP route', async () => {
  const { manager, router, agents } = setup()
  const id = await makeSession(manager, agents)

  const res = await router('POST', `/sessions/${id}/rewind`, { messageIndex: 2 }, AUTH)
  assert.equal(res.status, 200)
  assert.equal(agents[agents.length - 1]!.messages.length, 2, 'messages truncated via route')
})

test('#8 POST /rewind returns 409 when session is running', async () => {
  const { manager, router, agents } = setup()
  const id = await makeSession(manager, agents)
  manager.run(id, 'busy')

  const res = await router('POST', `/sessions/${id}/rewind`, { messageIndex: 2 }, AUTH)
  assert.equal(res.status, 409)
})

test('#9 [反证 #2] SessionContext.replaceMessages resets turnCount + turnCacheHistory', () => {
  // Directly test SessionContext — the mock agent can't verify derived state.
  const ctx = new SessionContext()
  // Simulate 3 turns
  ctx.addUserMessage('msg1')
  ctx.addAssistantBlocks([{ type: 'text', text: 'resp1' }])
  ctx.addUserMessage('msg2')
  ctx.addAssistantBlocks([{ type: 'text', text: 'resp2' }])
  ctx.addUserMessage('msg3')
  ctx.addAssistantBlocks([{ type: 'text', text: 'resp3' }])
  ctx.recordTurnCache(3, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 })

  assert.equal(ctx.getTurnCount(), 3, '3 user messages → turnCount 3')

  // Rewind to turn 1: keep only first user+assistant pair
  const msgs = ctx.getMessages().slice(0, 2)
  ctx.replaceMessages(msgs)

  assert.equal(ctx.getTurnCount(), 1, 'after rewind turnCount should be 1')
  assert.equal(ctx.getCacheHistory().length, 0, 'turnCacheHistory should be cleared')
})
