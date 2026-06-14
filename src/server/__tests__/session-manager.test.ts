import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  aborted = false
  artifacts: Artifact[] = []
  private resolveRun?: () => void

  run(_prompt: string, cb: AgentCallbacks): Promise<void> {
    this.callbacks = cb
    return new Promise<void>((res) => { this.resolveRun = res })
  }
  finish(): void { this.resolveRun?.() }
  abort(): void {
    this.aborted = true
    this.callbacks?.onAbort()
    this.resolveRun?.()
  }
  listArtifacts(): Artifact[] { return this.artifacts }
  readArtifact(id: string): Promise<string | null> {
    return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null)
  }
}

function makeArtifact(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id,
    tool: 'read_file',
    target: 'foo.ts',
    sessionId: 's',
    createdAt: 1,
    summary: 'sum',
    sections: [],
    rawPath: `/tmp/${id}.raw`,
    charCount: 10,
    lineCount: 2,
    sha256: 'x',
    ...over,
  }
}

function makeManager() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
  })
  return { manager, agents }
}

test('createSession with prompt starts running; without prompt stays idle', () => {
  const { manager } = makeManager()
  const idle = manager.createSession({})
  assert.equal(idle.status, 'idle')

  const live = manager.createSession({ prompt: 'go' })
  assert.equal(live.status, 'running')
  assert.notEqual(idle.id, live.id)
})

test('two parallel sessions have distinct ids and abort is isolated', () => {
  const { manager, agents } = makeManager()
  const a = manager.createSession({ prompt: 'a' })
  const b = manager.createSession({ prompt: 'b' })
  assert.notEqual(a.id, b.id)

  manager.abort(a.id)
  assert.equal(agents[0]!.aborted, true)
  assert.equal(agents[1]!.aborted, false, 'aborting A must not touch B')
  assert.equal(manager.getSession(a.id)!.status, 'aborted')
  assert.equal(manager.getSession(b.id)!.status, 'running')
})

test('unsubscribing an event viewer does NOT abort the session', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const stop = manager.subscribe(s.id, () => {})
  assert.ok(stop)
  stop!()
  assert.equal(agents[0]!.aborted, false)
  assert.equal(manager.getSession(s.id)!.status, 'running')
})

test('getEvents(since) replays only newer events with monotonic seq', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onTextDelta('hello ')
  cb.onTextDelta('world')

  const all = manager.getEvents(s.id, 0)!
  // status(running) + 2 text deltas
  assert.ok(all.events.length >= 3)
  const seqs = all.events.map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'seq must be monotonic')

  const since = all.lastSeq
  cb.onTextDelta('!')
  const tail = manager.getEvents(s.id, since)!
  assert.equal(tail.events.length, 1)
  assert.equal(tail.events[0]!.data.text, '!')
  assert.ok(tail.events[0]!.seq > since)
})

test('approval is a two-way intervention resolved out of band', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  const pending = cb.onApprovalRequired('tool-1', 'bash', { command: 'rm x' })
  assert.equal(manager.getSession(s.id)!.pendingApprovals, 1)
  const reqEvent = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'approval_required')
  assert.ok(reqEvent)
  assert.equal(reqEvent!.data.requestId, 'tool-1')

  const ok = manager.answerIntervention(s.id, 'tool-1', 'approve')
  assert.equal(ok, true)
  const result = await pending
  assert.deepEqual(result, { approved: true })
  assert.equal(manager.getSession(s.id)!.pendingApprovals, 0)
  const resolved = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'approval_resolved')
  assert.equal(resolved!.data.decision, 'approve')
})

test('rejecting approval resolves with approved:false', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const pending = agents[0]!.callbacks!.onApprovalRequired('t', 'write_file', {})
  manager.answerIntervention(s.id, 't', 'reject')
  assert.deepEqual(await pending, { approved: false })
})

test('abort resolves all pending approvals (no hung promises)', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const pending = agents[0]!.callbacks!.onApprovalRequired('t', 'bash', {})
  manager.abort(s.id)
  assert.deepEqual(await pending, { approved: false })
  assert.equal(manager.getSession(s.id)!.pendingApprovals, 0)
})

test('artifacts are surfaced per session and never cross-read', async () => {
  const { manager, agents } = makeManager()
  const a = manager.createSession({ prompt: 'a' })
  const b = manager.createSession({ prompt: 'b' })
  agents[0]!.artifacts = [makeArtifact('read_file:aaa')]
  agents[1]!.artifacts = [makeArtifact('grep:bbb', { tool: 'grep' })]

  // tool_result triggers an artifact scan + 'artifact' event
  agents[0]!.callbacks!.onToolResult('id1', 'read_file', 'ok', false)

  const aList = manager.listArtifacts(a.id)!
  const bList = manager.listArtifacts(b.id)!
  assert.deepEqual(aList.map((x) => x.id), ['read_file:aaa'])
  assert.deepEqual(bList.map((x) => x.id), ['grep:bbb'])

  const artEvent = manager.getEvents(a.id, 0)!.events.find((e) => e.type === 'artifact')
  assert.equal(artEvent!.data.id, 'read_file:aaa')

  assert.equal(await manager.readArtifact(b.id, 'read_file:aaa'), null, 'B must not read A artifact')
  assert.equal(await manager.readArtifact(a.id, 'read_file:aaa'), 'raw:read_file:aaa')
})

test('run() is rejected while a session is already running', () => {
  const { manager } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  assert.equal(manager.run(s.id, 'again'), false)
})

test('completed run emits a terminal done event', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))
  const events = manager.getEvents(s.id, 0)!.events
  assert.ok(events.some((e) => e.type === 'done'))
  assert.equal(manager.getSession(s.id)!.status, 'completed')
})
