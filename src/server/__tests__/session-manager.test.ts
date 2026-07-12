import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Flush enough event-loop iterations to cover setImmediate + setTimeout(0)
 *  (watchdog auto-continue's two-stage timer chain). Old settle(5) was too
 *  short when maybeWatchdogAutoContinue gained a setImmediate→setTimeout(0) hop. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 5))
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))
}
import { RuntimeSessionManager, type ManagedAgent, type ModelOption, type DelegateActivityUpdate } from '../session-manager.js'
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
  /** 每次 run 收到的 prompt，按序记录（含自动续跑注入的 'continue'）。 */
  prompts: string[] = []
  private resolveRun?: () => void

  run(prompt: string, cb: AgentCallbacks): Promise<void> {
    this.prompts.push(prompt)
    this.callbacks = cb
    return new Promise<void>((res) => { this.resolveRun = res })
  }
  finish(): void { this.resolveRun?.() }
  abort(): void {
    this.aborted = true
    this.callbacks?.onAbort()
    this.resolveRun?.()
  }
  /** 模拟 agent 内部 watchdog 自中止：带 reason 的 onAbort + run settle。
   *  与 abort()（用户中止，无 reason）区分——manager.abort 不走这条路。 */
  watchdogAbort(reason = 'watchdog:goal'): void {
    this.callbacks?.onAbort(reason)
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
  /** P0-2: optional — plan_task onToolResult reads this to emit todo_state */
  getTodos?: () => Array<{ id: string; content: string; status: string }>
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

function makeManager(opts: { watchdogContinueDelayMs?: number } = {}) {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
    // C2 倒计时默认 5s——测试里压到 0（setImmediate+setTimeout(0) 仍被 settle 覆盖），
    // 倒计时行为本身由专门用例以小延迟验证。
    watchdogContinueDelayMs: opts.watchdogContinueDelayMs ?? 0,
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

// Redaction now lives ONLY here (the legacy /prompt route forwards manager
// events verbatim since its session rebase) — this is the single trust boundary
// keeping secrets out of event logs and every SSE stream.
test('manager redacts sensitive tool input and error text before they reach the event log', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onToolUse('id-1', 'bash', { command: 'curl api', api_key: 'sk-super-secret' })
  cb.onError(new Error('upstream 401 token=server-secret'))

  const events = manager.getEvents(s.id, 0)!.events
  const toolUse = events.find((e) => e.type === 'tool_use')!
  assert.equal((toolUse.data.input as Record<string, unknown>).api_key, '[REDACTED]')
  const error = events.find((e) => e.type === 'error')!
  assert.ok(String(error.data.error).includes('token=[REDACTED]'))
  assert.ok(!String(error.data.error).includes('server-secret'))
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

test('computer_use approve + remember records a per-app grant (always allow)', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { isAppGranted } = await import('../../tools/computer-use/app-grants.js')
  const home = mkdtempSync(join(tmpdir(), 'rivet-cu-remember-'))
  const prevHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  t.after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  // approve WITHOUT remember → no grant
  const p1 = cb.onApprovalRequired('cu-1', 'computer_use', { action: 'snapshot', app: 'Safari' })
  manager.answerIntervention(s.id, 'cu-1', 'approve')
  assert.deepEqual(await p1, { approved: true })
  assert.equal(isAppGranted('Safari'), false, 'plain approve must not grant')

  // approve WITH remember → grant recorded + event annotated
  const p2 = cb.onApprovalRequired('cu-2', 'computer_use', { action: 'click', app: 'Safari', ref: 1 })
  manager.answerIntervention(s.id, 'cu-2', 'approve', undefined, true)
  assert.deepEqual(await p2, { approved: true })
  assert.equal(isAppGranted('Safari'), true, 'approve+remember must grant the app')
  const resolved = manager.getEvents(s.id, 0)!.events
    .filter((e) => e.type === 'approval_resolved')
    .find((e) => e.data.requestId === 'cu-2')
  assert.equal(resolved!.data.rememberedApp, 'Safari')

  // remember on a NON-computer_use tool → no grant side effect
  const p3 = cb.onApprovalRequired('b-1', 'bash', { command: 'ls' })
  manager.answerIntervention(s.id, 'b-1', 'approve', undefined, true)
  assert.deepEqual(await p3, { approved: true })

  // reject + remember → no grant
  const p4 = cb.onApprovalRequired('cu-3', 'computer_use', { action: 'snapshot', app: 'Notes' })
  manager.answerIntervention(s.id, 'cu-3', 'reject', undefined, true)
  assert.deepEqual(await p4, { approved: false })
  assert.equal(isAppGranted('Notes'), false, 'reject+remember must not grant')
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
  const resolved = manager.getEvents(s.id, 0)!.events
    .filter((e) => e.type === 'approval_resolved')
    .find((e) => e.data.requestId === 't')
  assert.equal(resolved!.data.decision, 'aborted', '用户中止的审批关闭保持 aborted 语义')
})

test('run 正常完成时挂起 approval 关闭为 stale，不误标 aborted', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  const pending = a.callbacks!.onApprovalRequired('t1', 'bash', { command: 'ls' })
  // run 正常 settle，approval 仍挂起（真实 agent 不应发生，但 manager 必须诚实收尾）
  a.finish()
  await settle()
  assert.deepEqual(await pending, { approved: false }, 'promise 必须被关闭，不能悬挂')
  const rec = manager.getSession(s.id)!
  assert.equal(rec.status, 'completed')
  assert.equal(rec.pendingApprovals, 0)
  const resolved = manager.getEvents(s.id, 0)!.events
    .filter((e) => e.type === 'approval_resolved')
    .find((e) => e.data.requestId === 't1')
  assert.ok(resolved, '必须有 approval_resolved 收尾事件')
  assert.equal(resolved!.data.decision, 'stale', '正常完成的收尾不得伪装成 aborted')
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

test('P0-2: plan_task success emits todo_state via onToolResult', () => {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      // P0-2: plan_task onToolResult reads session.agent.getTodos()
      a.getTodos = () => [
        { id: '1', content: 'step one', status: 'pending' },
        { id: '2', content: 'step two', status: 'pending' },
      ]
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
  })
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  // plan_task success → todo_state emitted
  cb.onToolResult('plan1', 'plan_task', 'ok', false)
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'todo_state')
  assert.equal(evs.length, 1)
  assert.deepEqual(evs[0]!.data.items, [
    { id: '1', content: 'step one', status: 'pending' },
    { id: '2', content: 'step two', status: 'pending' },
  ])
})

test('P0-2: plan_task error does NOT emit todo_state', () => {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      a.getTodos = () => [
        { id: '1', content: 'step one', status: 'pending' },
      ]
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
  })
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  // plan_task error → no todo_state
  cb.onToolResult('plan1', 'plan_task', 'error', true)
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'todo_state')
  assert.equal(evs.length, 0)
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

// ── User-dispatched background subagent ─────────────────────────────

/** Fake exposing delegateWorker; lets a test drive activity + completion. */
class DelegateFakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  lastInput?: { objective: string; profile?: string; authority?: string; files?: string[] }
  lastOpts?: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void }
  private resolveRun?: () => void
  run(_p: string, cb: AgentCallbacks): Promise<void> { this.callbacks = cb; return new Promise<void>((r) => { this.resolveRun = r }) }
  finish(): void { this.resolveRun?.() }
  abort(): void { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
  delegateWorker(
    input: { objective: string; profile?: string; authority?: string; files?: string[] },
    opts: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void },
  ): Promise<void> {
    this.lastInput = input
    this.lastOpts = opts
    // Stay pending so the test can drive onActivity then resolve manually.
    return new Promise<void>(() => {})
  }
}

function makeDelegateManager() {
  const agents: DelegateFakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new DelegateFakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  return { manager, agents }
}

test('delegate: dispatches a worker WITHOUT setting session.running', () => {
  const { manager, agents } = makeDelegateManager()
  const s = manager.createSession({})
  const res = manager.delegate(s.id, { objective: '查登录验证码', profile: 'code_scout' })
  assert.equal(res.ok, true)
  // Session stays idle — a background worker must not flip the main turn flag.
  assert.notEqual(manager.getSession(s.id)!.status, 'running')
  // The agent received the request with our stable workerId as parent key.
  assert.equal(agents[0]!.lastInput!.objective, '查登录验证码')
  assert.equal(agents[0]!.lastOpts!.workerId, res.ok ? res.workerId : '')
})

test('delegate: emits a running delegation node with origin=user', () => {
  const { manager } = makeDelegateManager()
  const s = manager.createSession({})
  const res = manager.delegate(s.id, { objective: 'go', profile: 'reviewer' })
  assert.equal(res.ok, true)
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  assert.equal(evs.length, 1)
  assert.equal(evs[0]!.data.status, 'running')
  assert.equal(evs[0]!.data.origin, 'user')
  assert.equal(evs[0]!.data.objective, 'go')
  assert.equal(evs[0]!.data.profile, 'reviewer')
})

test('delegate: onActivity terminal update carries summary + origin', () => {
  const { manager, agents } = makeDelegateManager()
  const s = manager.createSession({})
  const res = manager.delegate(s.id, { objective: 'go' })
  assert.ok(res.ok)
  const workerId = res.ok ? res.workerId : ''
  // Simulate the worker finishing with a digest.
  agents[0]!.lastOpts!.onActivity({
    workOrderId: workerId,
    status: 'passed',
    summary: '改了 2 个文件',
    changedFiles: ['a.ts', 'b.ts'],
  })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  const terminal = evs[evs.length - 1]!
  assert.equal(terminal.data.status, 'passed')
  assert.equal(terminal.data.summary, '改了 2 个文件')
  assert.equal(terminal.data.origin, 'user')
  assert.deepEqual(terminal.data.changedFiles, ['a.ts', 'b.ts'])
})

test('delegate: empty objective is rejected', () => {
  const { manager } = makeDelegateManager()
  const s = manager.createSession({})
  const res = manager.delegate(s.id, { objective: '   ' })
  assert.deepEqual(res, { ok: false, reason: 'invalid' })
})

test('delegate: missing session is rejected', () => {
  const { manager } = makeDelegateManager()
  const res = manager.delegate('nope', { objective: 'go' })
  assert.deepEqual(res, { ok: false, reason: 'not_found' })
})

test('cancelDelegate: aborts the worker signal; unknown returns false', () => {
  const { manager, agents } = makeDelegateManager()
  const s = manager.createSession({})
  const res = manager.delegate(s.id, { objective: 'go' })
  assert.ok(res.ok)
  const workerId = res.ok ? res.workerId : ''
  assert.equal(agents[0]!.lastOpts!.signal.aborted, false)
  assert.equal(manager.cancelDelegate(s.id, workerId), true)
  assert.equal(agents[0]!.lastOpts!.signal.aborted, true)
  assert.equal(manager.cancelDelegate(s.id, 'ghost'), false)
})

test('delegate: coexists with a running main turn (anytime dispatch)', () => {
  const { manager } = makeDelegateManager()
  const s = manager.createSession({ prompt: 'main task' })
  assert.equal(manager.getSession(s.id)!.status, 'running')
  // Background dispatch must succeed even while the main turn runs.
  const res = manager.delegate(s.id, { objective: 'side quest' })
  assert.equal(res.ok, true)
})

// ── Watchdog stall auto-recovery (桌面端对齐 TUI v3) ────────────────────────

test('watchdog:goal 中止后自动续跑：agent 收到第二次 run(continue)，status 回到 running', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog:goal')
  await settle()

  assert.deepEqual(agents[0]!.prompts, ['go', 'continue'])
  assert.equal(manager.getSession(s.id)!.status, 'running', '续跑后不停留在 aborted')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.ok(ev, '必须追加 watchdog_recovery 事件')
  assert.equal(ev!.data.autoContinue, true)
})

test('普通 watchdog（非 goal）同样自动续跑', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog')
  await settle()
  assert.deepEqual(agents[0]!.prompts, ['go', 'continue'])
  assert.equal(manager.getSession(s.id)!.status, 'running')
})

test('用户 abort（无 reason）与 convergence 中止不自动续跑', async () => {
  const { manager, agents } = makeManager()
  const a = manager.createSession({ prompt: 'a' })
  manager.abort(a.id)                       // FakeAgent.abort → onAbort() 无 reason
  await settle()
  assert.deepEqual(agents[0]!.prompts, ['a'], '用户中止不得续跑')
  assert.equal(manager.getSession(a.id)!.status, 'aborted')

  const b = manager.createSession({ prompt: 'b' })
  agents[1]!.callbacks!.onAbort('convergence:no-tool')
  agents[1]!.finish()
  await settle()
  assert.deepEqual(agents[1]!.prompts, ['b'], 'convergence 中止不得续跑')
})

test('密集 stall（tiny-turn 循环）12 次后停手，事件含 stopReason=session-total', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  for (let i = 0; i < 15; i++) {
    a.callbacks!.onTurnComplete({}, 1, false)   // tiny-turn：重置 consecutive
    a.watchdogAbort('watchdog:goal')
    await settle()
  }
  const continues = a.prompts.filter((p) => p === 'continue').length
  assert.equal(continues, 12, `session-total cap 应在 12 次后停手，实得 ${continues}`)
  assert.equal(manager.getSession(s.id)!.status, 'aborted', '停手后落 aborted 等用户')
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'watchdog_recovery')
  assert.equal(evs[evs.length - 1]!.data.stopReason, 'session-total')
})

test('稀疏 stall（每次间隔 2 个工具批）不消耗配额，15 次全续跑', async () => {
  const { manager, agents } = makeManager()
  manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  for (let i = 0; i < 15; i++) {
    for (let j = 0; j < 2; j++) {
      a.callbacks!.onToolResult(`t${i}-${j}`, 'read_file', 'ok', false)
      a.callbacks!.onTurnComplete({}, 1, false)
    }
    a.watchdogAbort('watchdog:goal')
    await settle()
  }
  assert.equal(a.prompts.filter((p) => p === 'continue').length, 15)
})

test('流式 chunk（isError=undefined）不计进度：密集 stall 仍 12 次停手', async () => {
  const { manager, agents } = makeManager()
  manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  for (let i = 0; i < 15; i++) {
    for (let j = 0; j < 4; j++) a.callbacks!.onToolResult(`t${i}`, 'bash', `chunk${j}`)  // 无 isError
    a.callbacks!.onToolResult(`t${i}`, 'bash', 'done', false)   // 终态
    a.callbacks!.onTurnComplete({}, 1, false)
    // 每周期真实进度 = 2 单元 < 4 → 密集
    a.watchdogAbort('watchdog:goal')
    await settle()
  }
  const continues = a.prompts.filter((p) => p === 'continue').length
  assert.equal(continues, 12, `chunk 若被误计会伪装稀疏无限续跑，实得 ${continues}`)
})

test('审批挂起时 stall → suppressed：不续跑，事件可观测', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  void a.callbacks!.onApprovalRequired('t1', 'bash', { command: 'rm x' })  // 挂起不答复
  a.watchdogAbort('watchdog:goal')
  await settle()
  assert.deepEqual(a.prompts, ['go'], '审批挂起的 stall 不得续跑')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.equal(ev!.data.stopReason, 'suppressed')
})

test('审批拒绝后 5s grace 窗口内的 stall 被抑制，窗口外恢复续跑（假时钟）', async () => {
  let clock = 1_000_000
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    now: () => clock,
    watchdogContinueDelayMs: 0,
  })
  const s = manager.createSession({ prompt: 'go' })
  const sid = s.id
  const a = agents[0]!
  const pending = a.callbacks!.onApprovalRequired('t1', 'bash', { command: 'rm x' })
  // requestApproval 用 toolId 作 requestId（session-manager.ts:2101 已核实）
  manager.answerIntervention(sid, 't1', 'reject')
  assert.deepEqual(await pending, { approved: false })

  clock += 1_000                              // 拒绝后 1s——窗口内
  a.watchdogAbort('watchdog:goal')
  await settle()
  assert.deepEqual(a.prompts, ['go'], 'grace 窗口内不得续跑')

  clock += 10_000                             // 拒绝后 11s——窗口外
  manager.run(sid, 'again')                   // 用户重新驱动
  a.watchdogAbort('watchdog:goal')
  await settle()
  assert.equal(a.prompts.filter((p) => p === 'continue').length, 1, '窗口外恢复续跑')
})

test('abort 后用户抢先提交新 prompt：自动续跑让位', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  a.watchdogAbort('watchdog:goal')
  // 只排干微任务（run().finally 是 promise 回调），不让 setImmediate 宏任务先跑
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(manager.run(s.id, '用户新指令'), true, '此刻 running 已清，用户可提交')
  await settle()
  assert.deepEqual(a.prompts, ['go', '用户新指令'], '自动 continue 必须让位给用户')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.equal(ev, undefined, '让位时不产生 recovery 事件')
})

test('watchdog stall 后、setImmediate 执行前用户 abort → 不续跑（窄窗口竞态）', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  a.watchdogAbort('watchdog:goal')
  // 只排干微任务（run().finally），setImmediate 宏任务还没跑
  for (let i = 0; i < 10; i++) await Promise.resolve()
  // 用户在此窗口内 abort——abort() 对已停会话目前是空操作（status 已 aborted、
  // agent 已停、pending 已空），但用户意图是"停"，不应被自动续跑盖掉
  manager.abort(s.id)
  await settle()
  assert.deepEqual(a.prompts, ['go'], '用户 abort 后不得自动续跑')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.equal(ev, undefined, '用户 abort 抑制续跑，不产生 recovery 事件')
})

// ── C2 刹车：watchdog 续跑倒计时可取消 ────────────────────────────────────

test('C2: 续跑先发 pendingAutoContinue 事件，倒计时结束才真正 continue', async () => {
  const { manager, agents } = makeManager({ watchdogContinueDelayMs: 30 })
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog:goal')
  await settle() // setImmediate 已跑：事件已追加，但倒计时(30ms)未到

  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.ok(ev, '决策后立即追加 watchdog_recovery 事件')
  assert.equal(ev!.data.pendingAutoContinue, true)
  assert.equal(ev!.data.delayMs, 30)
  assert.deepEqual(agents[0]!.prompts, ['go'], '倒计时内不得续跑')

  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(agents[0]!.prompts, ['go', 'continue'], '倒计时结束后续跑')
  assert.equal(manager.getSession(s.id)!.status, 'running')
})

test('C2: 倒计时窗口内用户 abort → 取消续跑并追加 cancelled 事件', async () => {
  const { manager, agents } = makeManager({ watchdogContinueDelayMs: 30 })
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog:goal')
  await settle() // 倒计时已挂起

  manager.abort(s.id)
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(agents[0]!.prompts, ['go'], '取消后不得续跑')
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'watchdog_recovery')
  assert.ok(evs.some((e) => e.data.cancelled === true), '必须追加 cancelled 事件供 UI 收卡片')
})

test('C2: 倒计时窗口内用户发新 prompt → 定时器清除，continue 不追发', async () => {
  const { manager, agents } = makeManager({ watchdogContinueDelayMs: 30 })
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  a.watchdogAbort('watchdog:goal')
  await settle()

  assert.equal(manager.run(s.id, '用户新指令'), true)
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(a.prompts, ['go', '用户新指令'], '用户 prompt 抢占，自动 continue 不得追发')
})

// ── Wave 2: delta 合并缓冲 ────────────────────────────────────────────────────

test('delta coalescing: first delta lands immediately, burst merges into one windowed event', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('a')          // first of the run → immediate
  cb.onTextDelta('b')
  cb.onTextDelta('c')
  cb.onTextDelta('d')

  // Live listeners must see only the immediate first event so far.
  const before = manager
    .getSession(s.id) && manager['sessions'].get(s.id)!.events.filter((e) => e.type === 'text_delta')
  assert.equal(before!.length, 1)
  assert.equal(before![0]!.data.text, 'a')

  await new Promise((r) => setTimeout(r, 60)) // > DELTA_COALESCE_MS
  const after = manager['sessions'].get(s.id)!.events.filter((e) => e.type === 'text_delta')
  assert.equal(after.length, 2, 'burst coalesces into one windowed event')
  assert.equal(after[1]!.data.text, 'bcd')
})

test('delta coalescing: non-delta event flushes the buffer first (order preserved)', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('x')
  cb.onTextDelta('y')          // buffered
  cb.onToolUse('t1', 'bash', { command: 'ls' })

  const evs = manager['sessions'].get(s.id)!.events
  const types = evs.map((e) => e.type)
  const yIdx = evs.findIndex((e) => e.type === 'text_delta' && e.data.text === 'y')
  const toolIdx = types.indexOf('tool_use')
  assert.ok(yIdx !== -1, 'buffered delta must be flushed by the tool_use')
  assert.ok(yIdx < toolIdx, 'flushed delta must precede the tool_use event')
})

test('delta coalescing: abort drains the buffer before the status event', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('head')
  cb.onTextDelta(' tail')      // buffered
  manager.abort(s.id)

  const evs = manager['sessions'].get(s.id)!.events
  const tailIdx = evs.findIndex((e) => e.type === 'text_delta' && e.data.text === ' tail')
  const statusIdx = evs.findIndex((e) => e.type === 'status' && e.data.status === 'aborted')
  assert.ok(tailIdx !== -1, 'buffered tail must not be lost on abort')
  assert.ok(tailIdx < statusIdx, 'tail must land before the aborted status')
})

test('delta coalescing: type switch (thinking↔text) flushes and keeps order', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onThinkingDelta('think1')  // immediate (first of thinking run)
  cb.onThinkingDelta('think2')  // buffered
  cb.onTextDelta('answer')      // type switch → flush think2, then immediate

  const evs = manager['sessions'].get(s.id)!.events.filter(
    (e) => e.type === 'text_delta' || e.type === 'thinking_delta',
  )
  assert.deepEqual(
    evs.map((e) => [e.type, e.data.text]),
    [['thinking_delta', 'think1'], ['thinking_delta', 'think2'], ['text_delta', 'answer']],
  )
})

test('delta coalescing: oversized buffer flushes at the char cap without waiting', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('first')                 // immediate
  cb.onTextDelta('x'.repeat(3000))        // exceeds cap → immediate flush

  const evs = manager['sessions'].get(s.id)!.events.filter((e) => e.type === 'text_delta')
  assert.equal(evs.length, 2)
  assert.equal((evs[1]!.data.text as string).length, 3000)
})

test('delta coalescing: getEvents drains the window and seq stays monotonic', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('one ')
  cb.onTextDelta('two')        // buffered — poll must still see it
  const all = manager.getEvents(s.id, 0)!
  const texts = all.events.filter((e) => e.type === 'text_delta').map((e) => e.data.text)
  assert.deepEqual(texts, ['one ', 'two'])
  const seqs = all.events.map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
})

test('delta coalescing: shutdownAll drains pending buffers', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('kept')
  cb.onTextDelta(' also kept')  // buffered
  manager.shutdownAll()

  const evs = manager['sessions'].get(s.id)!.events.filter((e) => e.type === 'text_delta')
  assert.deepEqual(evs.map((e) => e.data.text), ['kept', ' also kept'])
})
