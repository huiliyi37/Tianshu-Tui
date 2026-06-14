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
  rewindToMessages(msgs: OaiMessage[]): void { this.messages = msgs }
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

test('#4b rewind emits an anchorSeq matching the rewound user event', async () => {
  // Agent that mirrors each run into user+assistant messages, so the event
  // log's `user` events line up 1:1 with user messages (the real prompt flow).
  // Only then can the manager resolve a duplicate-proof UI anchor.
  class TurnMirrorAgent implements ManagedAgent {
    messages: OaiMessage[] = []
    run(prompt: string, _cb: AgentCallbacks): Promise<void> {
      this.messages.push({ role: 'user', content: prompt })
      this.messages.push({ role: 'assistant', content: 'ok' })
      return Promise.resolve()
    }
    finish(): void {}
    abort(): void {}
    listArtifacts(): Artifact[] { return [] }
    readArtifact(): Promise<string | null> { return Promise.resolve(null) }
    getMessages(): OaiMessage[] { return this.messages }
    replaceMessages(m: OaiMessage[]): void { this.messages = m }
    rewindToMessages(m: OaiMessage[]): void { this.messages = m }
  }
  const manager = new RuntimeSessionManager({
    createAgent: () => new TurnMirrorAgent(),
    defaultCwd: '/tmp',
  })
  const s = manager.createSession({ prompt: 'Hello' })
  await new Promise(r => setTimeout(r, 10))
  manager.run(s.id, 'Do task A')
  await new Promise(r => setTimeout(r, 10))
  manager.run(s.id, 'Now do B')
  await new Promise(r => setTimeout(r, 10))

  // messages: [u Hello, a ok, u Do task A, a ok, u Now do B, a ok]
  const points = manager.listRewindPoints(s.id)!
  assert.deepEqual(points.map(p => [p.index, p.content]), [[0, 'Hello'], [2, 'Do task A'], [4, 'Now do B']])

  assert.ok(manager.rewind(s.id, 2), 'rewind to "Do task A" should succeed')
  const events = manager.getEvents(s.id, 0)!.events
  const rewindEvent = events.find(e => e.type === 'rewind')!
  const userEvent = events.find(e => e.type === 'user' && e.data.text === 'Do task A')!
  assert.equal(rewindEvent.data.messageIndex, 2)
  assert.equal(rewindEvent.data.prompt, 'Do task A')
  assert.equal(rewindEvent.data.anchorSeq, userEvent.seq, 'anchorSeq points at the rewound user event')
})

test('#4c rewind omits anchorSeq when the event log diverges from messages', async () => {
  // The default harness injects messages out-of-band (no matching `user`
  // events), so the ordinal/text guard must drop anchorSeq and let the client
  // fall back to its text heuristic — never emit a wrong anchor.
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  manager.rewind(id, 2)
  const rewindEvent = manager.getEvents(id, 0)!.events.find(e => e.type === 'rewind')!
  assert.equal(rewindEvent.data.anchorSeq, undefined, 'diverged log → no anchor emitted')
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

test('#9 [反证 #2] SessionContext.rewindToMessages resets turnCount + turnCacheHistory + files', () => {
  const ctx = new SessionContext()
  // Simulate 3 turns
  ctx.addUserMessage('msg1')
  ctx.addAssistantBlocks([{ type: 'text', text: 'resp1' }])
  ctx.addUserMessage('msg2')
  ctx.addAssistantBlocks([{ type: 'text', text: 'resp2' }])
  ctx.addUserMessage('msg3')
  ctx.addAssistantBlocks([{ type: 'text', text: 'resp3' }])
  ctx.recordTurnCache(3, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 })
  ctx.trackFileRead('src/a.ts')
  ctx.trackFileModified('src/b.ts')

  assert.equal(ctx.getTurnCount(), 3, '3 user messages → turnCount 3')
  assert.ok(ctx.getFilesRead().includes('src/a.ts'), 'filesRead tracks read files')

  // Rewind to turn 1: keep only first user+assistant pair
  const msgs = ctx.getMessages().slice(0, 2)
  ctx.rewindToMessages(msgs)

  assert.equal(ctx.getTurnCount(), 1, 'after rewind turnCount should be 1')
  assert.equal(ctx.getCacheHistory().length, 0, 'turnCacheHistory should be cleared')
  assert.equal(ctx.getFilesRead().length, 0, 'filesRead should be cleared')
  assert.equal(ctx.getFilesModified().length, 0, 'filesModified should be cleared')
})

test('#10 timestamp from event log', async () => {
  // Messages injected out-of-band (no 'user' events) → timestamp falls back to 0.
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)
  const points = manager.listRewindPoints(id)!

  // makeSession creates via createSession({ prompt: 'init' }) which fires a
  // real run → the event log contains a 'user' event for the first message.
  // The remaining messages are injected out-of-band → their timestamps are 0.
  assert.ok(points.length >= 3, 'should have at least 3 user messages')
  assert.ok(points[0]!.timestamp > 0, 'first user msg (from real run) should have timestamp > 0')
})

test('#11 rewind with rollbackFiles does not crash', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  // rollbackFiles: true triggers dynamic import of checkpoint.ts.
  // In unit tests there's no real git repo → the best-effort catch swallows.
  // The important thing is: rewind still succeeds on the message path.
  const ok = manager.rewind(id, 2, { rollbackFiles: true })
  assert.ok(ok, 'rewind with rollbackFiles should return true')
  // Messages should still be truncated even if file rollback failed silently.
  assert.equal(agents[agents.length - 1]!.messages.length, 2, 'messages truncated')
})
