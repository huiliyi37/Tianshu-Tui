import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent, type ModelOption } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { ActiveStarDomain } from '../../agent/star-domain.js'

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
  rewindToMessages(msgs: OaiMessage[]): void { this.messages = msgs }
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

test('sameCwdRunningCount counts running sessions per cwd (VSW §6)', () => {
  const { manager } = makeManager()
  const a = manager.createSession({ prompt: 'a', cwd: '/repo/x' })
  manager.createSession({ prompt: 'b', cwd: '/repo/x' })
  manager.createSession({ prompt: 'c', cwd: '/repo/y' })
  manager.createSession({ cwd: '/repo/x' }) // idle, not running

  // 2 running in /repo/x, 1 in /repo/y
  assert.equal(manager.sameCwdRunningCount('/repo/x'), 2)
  assert.equal(manager.sameCwdRunningCount('/repo/y'), 1)
  assert.equal(manager.sameCwdRunningCount('/repo/z'), 0)

  // excluding self yields "other concurrent sessions" → 1
  assert.equal(manager.sameCwdRunningCount('/repo/x', a.id), 1)

  // path forms of the same cwd resolve equal
  assert.equal(manager.sameCwdRunningCount('/repo/x/'), 2)
})

test('sameCwdRunningCount drops sessions once they finish', async () => {
  const { manager, agents } = makeManager()
  manager.createSession({ prompt: 'a', cwd: '/repo/q' })
  manager.createSession({ prompt: 'b', cwd: '/repo/q' })
  assert.equal(manager.sameCwdRunningCount('/repo/q'), 2)
  agents[0]!.finish()
  // The running flag clears in the run-completion handler (a microtask).
  await new Promise((r) => setImmediate(r))
  assert.equal(manager.sameCwdRunningCount('/repo/q'), 1)
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

test('idle/rehydrated session reads artifact bodies straight off disk', async () => {
  // An agentless session (idle or restored after a sidecar restart) must still
  // serve artifact list + raw bodies from the on-disk log the live agent wrote.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { ArtifactStore } = await import('../../artifact/store.js')

  const cwd = mkdtempSync(join(tmpdir(), 'rehydrate-art-'))
  const manager = new RuntimeSessionManager({
    createAgent: () => new FakeAgent(),
    defaultCwd: cwd,
  })
  // No prompt → agent stays null, exercising the rehydrated path.
  const s = manager.createSession({ cwd })

  // Mirror the live AgentLoop layout: <cwd>/.rivet/artifacts/<sessionId>
  const store = new ArtifactStore(join(cwd, '.rivet', 'artifacts'), s.id)
  const artId = await store.save({
    tool: 'read_file',
    target: 'foo.ts',
    summary: 'sum',
    sections: [],
    rawContent: 'line one\nline two',
  })

  const list = manager.listArtifacts(s.id)!
  assert.deepEqual(list.map((a) => a.id), [artId])
  assert.equal(await manager.readArtifact(s.id, artId), 'line one\nline two')
  assert.equal(await manager.readArtifact(s.id, 'missing:zzz'), null)
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

// ── T2: todo_state emission ─────────────────────────────────────────

test('T2: todo write tool emits a structured todo_state event', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onToolUse('t1', 'todo', {
    action: 'write',
    todos: [
      { id: 'a', content: 'first', status: 'in_progress' },
      { id: 'b', content: 'second', status: 'pending' },
    ],
  })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'todo_state')
  assert.equal(evs.length, 1)
  const items = evs[0]!.data.items as Array<{ id: string; content: string; status: string }>
  assert.deepEqual(items, [
    { id: 'a', content: 'first', status: 'in_progress' },
    { id: 'b', content: 'second', status: 'pending' },
  ])
})

test('T2: todo read action does NOT emit todo_state; bad statuses fall back to pending', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onToolUse('r1', 'todo', { action: 'read' })
  cb.onToolUse('w1', 'todo', { action: 'write', todos: [{ id: 'x', content: 'c', status: 'bogus' }] })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'todo_state')
  assert.equal(evs.length, 1, 'only the write action emits')
  const items = evs[0]!.data.items as Array<{ status: string }>
  assert.equal(items[0]!.status, 'pending')
})

// ── T3: mid-run steering ────────────────────────────────────────────

test('T3: steer on a running session queues, echoes, and drains once', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  assert.equal(manager.steer(s.id, 'focus on tests'), 'queued')
  const echoed = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'steer_queued')
  assert.equal(echoed.length, 1)
  assert.equal(echoed[0]!.data.text, 'focus on tests')

  const drained = cb.onSteerDrain!()
  assert.match(String(drained), /focus on tests/)
  assert.equal(cb.onSteerDrain!(), null, 'second drain is empty')
})

test('T3: steer on an idle session returns idle; missing returns not_found', () => {
  const { manager } = makeManager()
  const idle = manager.createSession({})
  assert.equal(manager.steer(idle.id, 'hi'), 'idle')
  assert.equal(manager.steer('nope', 'hi'), 'not_found')
})

test('T3: a fresh run drops guidance left over from a previous run', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  manager.steer(s.id, 'stale')
  agents[0]!.finish() // run resolves → session idle
  await new Promise((r) => setTimeout(r, 0)) // let the run's finally flip running=false
  assert.equal(manager.run(s.id, 'go again'), true) // reuses the same agent, fresh callbacks
  // The new run cleared the buffer, so the first drain sees nothing stale.
  assert.equal(agents[0]!.callbacks!.onSteerDrain!(), null)
})

// ── T4: structured per-worker delegation ────────────────────────────

test('T4: onDelegationActivity emits per-worker delegation with progress + elapsed', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onDelegationActivity!({
    workOrderId: 'wo:T1',
    parentToolId: 'tool-1',
    profile: 'code_scout',
    status: 'running',
    progressLine: '⚙ grep',
  })
  cb.onDelegationActivity!({
    workOrderId: 'wo:T1',
    parentToolId: 'tool-1',
    status: 'passed',
    progressLine: 'found it',
  })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  assert.equal(evs.length, 2)
  assert.equal(evs[0]!.data.workerId, 'wo:T1')
  assert.equal(evs[0]!.data.parentId, 'tool-1')
  assert.equal(evs[0]!.data.status, 'running')
  assert.equal(evs[0]!.data.progressLine, '⚙ grep')
  assert.equal(typeof evs[0]!.data.elapsedMs, 'number')
  assert.equal(evs[1]!.data.status, 'passed')
})

// ── PlusMenu: model / star-domain / skills ──────────────────────────

/** Richer fake exposing the optional PlusMenu surface for wiring assertions. */
class PlusFakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  messages: OaiMessage[] = []
  domain: ActiveStarDomain | null | undefined = undefined
  disabled = new Set<string>()
  model = 'model-a'
  private resolveRun?: () => void
  run(_p: string, cb: AgentCallbacks): Promise<void> { this.callbacks = cb; return new Promise<void>((r) => { this.resolveRun = r }) }
  finish(): void { this.resolveRun?.() }
  abort(): void { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(m: OaiMessage[]): void { this.messages = m }
  rewindToMessages(m: OaiMessage[]): void { this.messages = m }
  setSessionDomain(d: ActiveStarDomain | null): void { this.domain = d }
  resetSessionDomain(): void { this.domain = undefined }
  getSessionDomain(): ActiveStarDomain | null | undefined { return this.domain }
  setDisabledSkills(names: Set<string>): void { this.disabled = new Set(names) }
  switchModel(modelId: string): string | null {
    if (modelId === 'model-a' || modelId === 'model-b') { this.model = modelId; return modelId }
    return null
  }
}

function makePlusManager() {
  const agents: PlusFakeAgent[] = []
  const models: ModelOption[] = [
    { id: 'model-a', alias: 'Model A', provider: 'p', contextWindow: 128000 },
    { id: 'model-b', alias: 'Model B', provider: 'p', contextWindow: 256000 },
  ]
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new PlusFakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    listModels: () => models,
    defaultModelId: 'model-a',
  })
  return { manager, agents }
}

test('PlusMenu: listDomains flags Auto by default; setDomain pins a domain', () => {
  const { manager } = makePlusManager()
  const s = manager.createSession({})
  const entries = manager.listDomains(s.id)!
  assert.ok(entries.length >= 3)
  const auto = entries.find((e) => e.key === 'auto')!
  assert.equal(auto.current, true)

  assert.equal(manager.setDomain(s.id, 'tianshu'), true)
  const after = manager.listDomains(s.id)!
  assert.equal(after.find((e) => e.key === 'tianshu')!.current, true)
  assert.equal(after.find((e) => e.key === 'auto')!.current, false)
  assert.equal(manager.getSession(s.id)!.domain, 'tianshu')

  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'domain_changed')!
  assert.equal(ev.data.key, 'tianshu')
})

test('PlusMenu: setDomain rejects an unknown key', () => {
  const { manager } = makePlusManager()
  const s = manager.createSession({})
  assert.equal(manager.setDomain(s.id, 'nope-xyz'), false)
})

test('PlusMenu: domain selection applies to a lazily-built agent', () => {
  const { manager, agents } = makePlusManager()
  const s = manager.createSession({})
  manager.setDomain(s.id, 'tianshu') // before any agent exists
  manager.run(s.id, 'go')            // builds the agent → applySelections runs
  assert.equal(agents[0]!.domain?.id, 'tianshu')
})

test('PlusMenu: listModels flags current; switchModel updates record + emits', () => {
  const { manager } = makePlusManager()
  const s = manager.createSession({})
  const before = manager.listModels(s.id)!
  assert.equal(before.find((m) => m.id === 'model-a')!.current, true)

  assert.equal(manager.switchModel(s.id, 'model-b'), true)
  assert.equal(manager.getSession(s.id)!.model, 'model-b')
  const after = manager.listModels(s.id)!
  assert.equal(after.find((m) => m.id === 'model-b')!.current, true)
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'model_switched')!
  assert.equal(ev.data.modelId, 'model-b')
})

test('PlusMenu: switchModel rejects unknown id and refuses while running', () => {
  const { manager } = makePlusManager()
  const s = manager.createSession({})
  assert.equal(manager.switchModel(s.id, 'ghost'), false)

  manager.run(s.id, 'go') // now running
  assert.equal(manager.switchModel(s.id, 'model-b'), false)
})

test('PlusMenu: setSkillEnabled toggles disabled set + applies to live agent', () => {
  const { manager, agents } = makePlusManager()
  const s = manager.createSession({})
  manager.run(s.id, 'go') // build agent so live-apply path runs
  assert.equal(manager.setSkillEnabled(s.id, 'leave-ritual', false), true)
  assert.ok(agents[0]!.disabled.has('leave-ritual'))
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'skills_changed')!
  assert.equal(ev.data.name, 'leave-ritual')
  assert.equal(ev.data.enabled, false)

  // Re-enabling removes it from the disabled set.
  manager.setSkillEnabled(s.id, 'leave-ritual', true)
  assert.equal(agents[0]!.disabled.has('leave-ritual'), false)
})

test('PlusMenu: missing session yields undefined/false from menu methods', () => {
  const { manager } = makePlusManager()
  assert.equal(manager.listModels('nope'), undefined)
  assert.equal(manager.listDomains('nope'), undefined)
  assert.equal(manager.listSkills('nope'), undefined)
  assert.equal(manager.setDomain('nope', 'auto'), false)
  assert.equal(manager.switchModel('nope', 'model-a'), false)
  assert.equal(manager.setSkillEnabled('nope', 'x', false), false)
})
