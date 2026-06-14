import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  aborted = false
  artifacts: Artifact[] = []
  /** Rewind: in-memory message store for testing. */
  messages: OaiMessage[] = []
  /** S — captures the mode this agent was built with + any live switches. */
  builtApprovalMode?: string
  liveApprovalMode?: string
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
  setApprovalMode(mode: string): void { this.liveApprovalMode = mode }
  listArtifacts(): Artifact[] { return this.artifacts }
  readArtifact(id: string): Promise<string | null> {
    return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null)
  }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(msgs: OaiMessage[]): void { this.messages = msgs }
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

test('createSession with prompt records a user event with the prompt text (Q1)', () => {
  const { manager } = makeManager()
  const s = manager.createSession({ prompt: '帮我重构这个模块' })
  const events = manager.getEvents(s.id, 0)!.events
  const userEvent = events.find((e) => e.type === 'user')
  assert.ok(userEvent, 'a user event must be recorded')
  assert.equal(userEvent!.data.text, '帮我重构这个模块')
  // user must precede status:running so the conversation renders in order
  const userIdx = events.findIndex((e) => e.type === 'user')
  const statusIdx = events.findIndex((e) => e.type === 'status')
  assert.ok(userIdx < statusIdx, 'user event must precede status')
})

test('subsequent run() records another user event (Q1)', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'first' })
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(manager.run(s.id, 'second'), true)
  const texts = manager.getEvents(s.id, 0)!.events
    .filter((e) => e.type === 'user')
    .map((e) => e.data.text)
  assert.deepEqual(texts, ['first', 'second'])
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

// ── R1: registry lifecycle (register / heartbeat / release) ──────────

interface FakeRegistryCalls {
  registered: Array<{ id: string; cwd: string; role: string }>
  heartbeats: string[]
  released: string[]
}

function makeManagerWithRegistry() {
  const agents: FakeAgent[] = []
  const calls: FakeRegistryCalls = { registered: [], heartbeats: [], released: [] }
  const fakeRegistry = {
    register: (id: string, cwd: string, role: string) => calls.registered.push({ id, cwd, role }),
    heartbeat: (id: string) => calls.heartbeats.push(id),
    releaseAllClaims: (id: string) => calls.released.push(id),
  }
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
    getSessionRegistry: () => fakeRegistry as any,
  })
  return { manager, agents, calls }
}

test('R1: createSession registers the session and run heartbeats the registry', () => {
  const { manager, calls } = makeManagerWithRegistry()
  const s = manager.createSession({ cwd: '/tmp/proj', prompt: 'go' })
  assert.deepEqual(calls.registered, [{ id: s.id, cwd: '/tmp/proj', role: 'standalone' }])
  assert.ok(calls.heartbeats.includes(s.id), 'run() must heartbeat the registry')
})

test('R1: a finished run releases the session claims', async () => {
  const { manager, agents, calls } = makeManagerWithRegistry()
  const s = manager.createSession({ prompt: 'go' })
  assert.equal(calls.released.length, 0, 'no release while running')
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(calls.released, [s.id], 'terminal state must release claims')
})

test('R1: two concurrent sessions register & release independently', async () => {
  const { manager, agents, calls } = makeManagerWithRegistry()
  const a = manager.createSession({ prompt: 'a' })
  const b = manager.createSession({ prompt: 'b' })
  assert.deepEqual(calls.registered.map((r) => r.id).sort(), [a.id, b.id].sort())
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(calls.released, [a.id], 'finishing A must not release B')
  assert.equal(manager.getSession(b.id)!.status, 'running')
})

// ── R5: decision_shift event ─────────────────────────────────────────

test('R5: onDecisionShift appends a decision_shift event with structured payload', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.callbacks!.onDecisionShift!({
    source: 'kick',
    domain: '天璇',
    reason: '检测到停滞',
    methods: ['换用 grep', '重新框定问题'],
    severity: 'warn',
  })
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'decision_shift')
  assert.ok(ev, 'a decision_shift event must be recorded')
  assert.equal(ev!.data.source, 'kick')
  assert.equal(ev!.data.domain, '天璇')
  assert.equal(ev!.data.reason, '检测到停滞')
  assert.deepEqual(ev!.data.methods, ['换用 grep', '重新框定问题'])
  assert.equal(ev!.data.severity, 'warn')
})

// ── S: per-session autonomy (approvalMode) ───────────────────────────

function makeManagerCapturingMode() {
  const built: Array<{ cwd?: string; sessionId?: string; approvalMode?: string }> = []
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: (cwd, sessionId, approvalMode) => {
      const a = new FakeAgent()
      a.builtApprovalMode = approvalMode
      built.push({ cwd, sessionId, approvalMode })
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
  })
  return { manager, agents, built }
}

test('S: createSession threads approvalMode into the agent factory + record', () => {
  const { manager, built } = makeManagerCapturingMode()
  const rec = manager.createSession({ prompt: 'go', approvalMode: 'dangerously-skip-permissions' })
  assert.equal(rec.approvalMode, 'dangerously-skip-permissions', 'record carries the mode')
  assert.equal(built.length, 1)
  assert.equal(built[0]!.approvalMode, 'dangerously-skip-permissions', 'factory received the mode')
})

test('S: createSession without approvalMode leaves it undefined (global default wins)', () => {
  const { manager, built } = makeManagerCapturingMode()
  const rec = manager.createSession({ prompt: 'go' })
  assert.equal(rec.approvalMode, undefined)
  assert.equal(built[0]!.approvalMode, undefined)
})

test('S: setApprovalMode live-switches a built agent and updates the record', () => {
  const { manager, agents } = makeManagerCapturingMode()
  const s = manager.createSession({ prompt: 'go' }) // builds the agent
  const ok = manager.setApprovalMode(s.id, 'dangerously-skip-permissions')
  assert.equal(ok, true)
  assert.equal(agents[0]!.liveApprovalMode, 'dangerously-skip-permissions', 'agent was live-mutated')
  assert.equal(manager.getSession(s.id)!.approvalMode, 'dangerously-skip-permissions', 'record updated')
})

test('S: setApprovalMode before first run applies on agent build', () => {
  const { manager, agents, built } = makeManagerCapturingMode()
  const s = manager.createSession({}) // idle: no agent yet
  assert.equal(built.length, 0, 'no agent built for an idle session')
  manager.setApprovalMode(s.id, 'manual')
  manager.run(s.id, 'go') // now builds
  assert.equal(built[0]!.approvalMode, 'manual', 'stored override used at build time')
  assert.equal(agents[0]!.builtApprovalMode, 'manual')
})

test('S: setApprovalMode returns false for a missing session', () => {
  const { manager } = makeManagerCapturingMode()
  assert.equal(manager.setApprovalMode('nope', 'manual'), false)
})
