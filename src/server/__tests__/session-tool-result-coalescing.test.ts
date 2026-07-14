import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type RuntimeSessionManagerOptions,
  type SessionEvent,
  type SessionPersistenceAdapter,
  type SessionRecord,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'

class FakeScheduler {
  private nextId = 1
  private tasks = new Map<number, () => void>()
  private cleared: Array<() => void> = []

  setTimeout(callback: () => void, _ms: number): number {
    const id = this.nextId++
    this.tasks.set(id, callback)
    return id
  }

  clearTimeout(id: unknown): void {
    const callback = this.tasks.get(id as number)
    if (callback) this.cleared.push(callback)
    this.tasks.delete(id as number)
  }

  runAll(): void {
    const callbacks = [...this.tasks.values()]
    this.tasks.clear()
    for (const callback of callbacks) callback()
  }

  runCleared(): void {
    const callbacks = this.cleared.splice(0)
    for (const callback of callbacks) callback()
  }

  get size(): number {
    return this.tasks.size
  }
}

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  callbackRuns: AgentCallbacks[] = []
  onPlanModeChange?: (state: 'off' | 'planning') => void
  listArtifactsCalls = 0
  concurrentRunAttempts = 0
  switchModelCalls = 0
  rewindCalls = 0
  private activeRuns = 0
  private resolveRuns: Array<() => void> = []
  private settledRuns = new Set<number>()
  run(_prompt: string, callbacks: AgentCallbacks): Promise<void> {
    if (this.activeRuns > 0) {
      this.concurrentRunAttempts++
      return Promise.reject(new Error('concurrent run rejected'))
    }
    this.activeRuns++
    this.callbacks = callbacks
    this.callbackRuns.push(callbacks)
    return new Promise((resolve) => { this.resolveRuns.push(resolve) })
  }
  finish(index = 0): void {
    if (!this.resolveRuns[index] || this.settledRuns.has(index)) return
    this.settledRuns.add(index)
    this.activeRuns--
    this.resolveRuns[index]!()
  }
  abort(): void {}
  listArtifacts() {
    this.listArtifactsCalls++
    return []
  }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages() { return [{ role: 'user' as const, content: 'first prompt' }] }
  replaceMessages(): void {}
  rewindToMessages(): void { this.rewindCalls++ }
  switchModel(modelId: string): string {
    this.switchModelCalls++
    return modelId
  }
}

class MemoryPersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  deleted = new Set<string>()
  appendsAfterDelete = 0
  savesAfterDelete = 0
  saveRecord(record: SessionRecord): void {
    if (this.deleted.has(record.id)) this.savesAfterDelete++
    this.records.set(record.id, { ...record })
  }
  appendEvent(id: string, event: SessionEvent): void {
    if (this.deleted.has(id)) this.appendsAfterDelete++
    const events = this.events.get(id) ?? []
    events.push(event)
    this.events.set(id, events)
  }
  loadAll() { return [] }
  sizeOf() { return 1 }
  deleteSession(id: string): void {
    this.deleted.add(id)
    this.records.delete(id)
    this.events.delete(id)
  }
}

class Deferred<T> {
  readonly promise: Promise<T>
  private settle?: (value: T) => void

  constructor() {
    this.promise = new Promise((resolve) => { this.settle = resolve })
  }

  resolve(value: T): void {
    this.settle?.(value)
  }
}

function setup(overrides: Partial<RuntimeSessionManagerOptions> = {}) {
  const scheduler = new FakeScheduler()
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const agent = new FakeAgent()
      agents.push(agent)
      return agent
    },
    defaultCwd: '/tmp/work',
    idleAgentTtlMs: 0,
    toolResultScheduler: scheduler,
    ...overrides,
  } as RuntimeSessionManagerOptions)
  const session = manager.createSession({ prompt: 'go' })
  return { manager, agent: agents[0]!, session, scheduler }
}

function toolResults(manager: RuntimeSessionManager, id: string): SessionEvent[] {
  return manager.getEvents(id, 0)!.events.filter((event) => event.type === 'tool_result')
}

describe('session tool_result stream coalescing', () => {
  it('emits the first chunk immediately and reduces 100 tiny chunks by at least 90%', () => {
    const { manager, agent, session, scheduler } = setup()
    const live: SessionEvent[] = []
    manager.subscribe(session.id, (event) => {
      if (event.type === 'tool_result') live.push(event)
    })
    for (let i = 0; i < 100; i++) agent.callbacks!.onToolResult('tool-1', 'bash', String(i))

    assert.equal(live.length, 1)
    assert.equal(live[0]!.data.result, '0')

    scheduler.runAll()
    const after = live
    assert.ok(after.length <= 10, `expected >=90% reduction, got ${after.length} events`)
    assert.equal(after.map((event) => event.data.result).join(''), Array.from({ length: 100 }, (_, i) => i).join(''))
  })

  it('flushes pending stream content before terminal result and error boundaries', () => {
    const { manager, agent, session } = setup()
    const cb = agent.callbacks!
    cb.onToolResult('tool-1', 'bash', 'head')
    cb.onToolResult('tool-1', 'bash', 'tail')
    cb.onToolResult('tool-1', 'bash', 'done', false, '/tmp/raw', 'compact done')
    cb.onToolResult('tool-2', 'bash', 'partial')
    cb.onToolResult('tool-2', 'bash', 'failed', true)
    cb.onError(new Error('boom'))

    const events = manager.getEvents(session.id, 0)!.events
    const relevant = events.filter((event) => event.type === 'tool_result' || event.type === 'error')
    assert.deepEqual(relevant.map((event) => [event.type, event.data.result ?? event.data.error]), [
      ['tool_result', 'head'],
      ['tool_result', 'tail'],
      ['tool_result', 'done'],
      ['tool_result', 'partial'],
      ['tool_result', 'failed'],
      ['error', 'boom'],
    ])
    assert.equal(relevant[2]!.data.uiContent, 'compact done')
  })

  it('treats model text as an ordering boundary for a pending tool stream', () => {
    const { manager, agent, session } = setup()
    const cb = agent.callbacks!
    cb.onToolResult('tool-1', 'bash', 'head')
    cb.onToolResult('tool-1', 'bash', 'tail')
    cb.onTextDelta('answer')

    const relevant = manager.getEvents(session.id, 0)!.events.filter(
      (event) => event.type === 'tool_result' || event.type === 'text_delta',
    )
    assert.deepEqual(relevant.map((event) => [event.type, event.data.result ?? event.data.text]), [
      ['tool_result', 'head'],
      ['tool_result', 'tail'],
      ['text_delta', 'answer'],
    ])
  })

  it('flushes before a different tool id so stdout/stderr-style arrival order is retained', () => {
    const { manager, agent, session } = setup()
    const cb = agent.callbacks!
    cb.onToolResult('a', 'bash', 'a1')
    cb.onToolResult('a', 'bash', 'a2')
    cb.onToolResult('b', 'bash', 'b1')
    cb.onToolResult('b', 'bash', 'b2')
    cb.onToolResult('a', 'bash', 'a3')

    const events = toolResults(manager, session.id)
    assert.deepEqual(events.map((event) => [event.data.id, event.data.result]), [
      ['a', 'a1'],
      ['a', 'a2'],
      ['b', 'b1'],
      ['b', 'b2'],
      ['a', 'a3'],
    ])
  })

  it('persists only coalesced events and replays their complete content', () => {
    const persistence = new MemoryPersistence()
    const { manager, agent, session, scheduler } = setup({ persistence })
    for (let i = 0; i < 100; i++) agent.callbacks!.onToolResult('tool-1', 'bash', 'x')
    scheduler.runAll()

    const stored = (persistence.events.get(session.id) ?? []).filter((event) => event.type === 'tool_result')
    assert.ok(stored.length <= 10)
    assert.equal(stored.map((event) => event.data.result).join(''), 'x'.repeat(100))
    assert.deepEqual(
      toolResults(manager, session.id).map((event) => event.data.result),
      stored.map((event) => event.data.result),
    )
  })

  it('splits a giant Unicode first chunk into bounded UTF-8-safe events without loss', () => {
    const { manager, agent, session, scheduler } = setup()
    const live: SessionEvent[] = []
    manager.subscribe(session.id, (event) => {
      if (event.type === 'tool_result') live.push(event)
    })
    const giant = '你😀abc'.repeat(8_000)
    const marker = '\n[stream output truncated]\n'

    agent.callbacks!.onToolResult('tool-1', 'bash', giant)
    agent.callbacks!.onToolResult('tool-1', 'bash', marker)
    scheduler.runAll()

    const results = live.map((event) => String(event.data.result))
    assert.equal(results.join(''), giant + marker)
    assert.ok(results.length > 10, 'giant first callback should be split into bounded events')
    assert.ok(results.every((result) => Buffer.byteLength(result) <= 2_048))
    assert.equal(results.join('').split('[stream output truncated]').length - 1, 1)
    for (const result of results) {
      assert.doesNotMatch(result, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/, 'event boundary split a surrogate pair')
    }
  })

  it('cancels and invalidates late tool stream timers across archive then permanent delete', () => {
    const persistence = new MemoryPersistence()
    const { manager, agent, session, scheduler } = setup({ persistence })
    const callbacks = agent.callbacks!

    callbacks.onToolResult('tool-1', 'bash', 'head')
    callbacks.onToolResult('tool-1', 'bash', 'pending-tail')
    assert.equal(manager.archiveSession(session.id), true)
    // Simulate callbacks already queued by the aborted agent after archive cleanup.
    callbacks.onToolResult('tool-1', 'bash', 'late-head')
    callbacks.onToolResult('tool-1', 'bash', 'late-tail')
    assert.deepEqual(manager.deleteSession(session.id), { ok: true, freedBytes: 1 })

    // Simulate a timer callback that was already dequeued when clearTimeout ran.
    scheduler.runCleared()
    scheduler.runAll()
    assert.equal(persistence.appendsAfterDelete, 0)
    assert.equal(persistence.events.has(session.id), false)
    assert.equal(manager.getSession(session.id), undefined)
  })

  it('ignores a terminal tool callback queued after permanent deletion', () => {
    const persistence = new MemoryPersistence()
    const { manager, agent, session } = setup({ persistence })
    const callbacks = agent.callbacks!

    assert.equal(manager.archiveSession(session.id), true)
    assert.deepEqual(manager.deleteSession(session.id), { ok: true, freedBytes: 1 })
    callbacks.onToolResult('tool-1', 'bash', 'late terminal', false, '/tmp/raw', 'late ui')

    assert.equal(persistence.appendsAfterDelete, 0)
    assert.equal(persistence.events.has(session.id), false, 'terminal callback must not recreate event storage')
    assert.equal(persistence.records.has(session.id), false, 'terminal callback must not recreate session metadata')
    assert.equal(agent.listArtifactsCalls, 0, 'terminal callback must not trigger artifact scanning')
    assert.equal(manager.getSession(session.id), undefined)
  })

  it('tombstones an in-flight run so late finally cannot recreate deleted durability', async () => {
    const persistence = new MemoryPersistence()
    const { manager, agent, session, scheduler } = setup({ persistence })

    assert.equal(manager.archiveSession(session.id), true)
    assert.deepEqual(manager.deleteSession(session.id), { ok: true, freedBytes: 1 })
    agent.finish()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(persistence.appendsAfterDelete, 0)
    assert.equal(persistence.savesAfterDelete, 0)
    assert.equal(persistence.events.has(session.id), false)
    assert.equal(persistence.records.has(session.id), false)
    assert.equal(scheduler.size, 0, 'late finalization must not leave delayed coalescer timers')
    assert.equal(manager.getSession(session.id), undefined)
  })

  it('ordinary run completion still appends done and persists completed status', async () => {
    const persistence = new MemoryPersistence()
    const { manager, agent, session } = setup({ persistence })

    agent.finish()
    await new Promise((resolve) => setImmediate(resolve))

    const events = persistence.events.get(session.id) ?? []
    assert.equal(events.at(-1)?.type, 'done')
    assert.equal(events.at(-1)?.data.status, 'completed')
    assert.equal(persistence.records.get(session.id)?.status, 'completed')
    assert.equal(manager.getSession(session.id)?.status, 'completed')
  })

  it('central tombstone blocks every late callback and clears session-owned timers', async () => {
    const persistence = new MemoryPersistence()
    const { manager, agent, session } = setup({ persistence, now: () => 1_000 })
    const callbacks = agent.callbacks!
    const internal = (manager as unknown as {
      sessions: Map<string, {
        record: SessionRecord
        deltaTimer?: unknown
        deltaBuf?: unknown
        planDraftTimer?: unknown
        watchdogContinueTimer?: unknown
        toolResultTimer?: unknown
        toolResultStream?: unknown
      }>
    }).sessions.get(session.id)!

    // Arm a real plan trailing timer and a real delta timer before deletion.
    internal.record.planMode = 'planning'
    ;(internal as { planDraftLastEmit?: number }).planDraftLastEmit = 751
    callbacks.onToolResult('write-1', 'write_file', 'done', false)
    callbacks.onThinkingDelta('think-head')
    callbacks.onThinkingDelta('think-tail')
    assert.ok(internal.planDraftTimer)
    assert.ok(internal.deltaTimer)
    internal.watchdogContinueTimer = setTimeout(() => {
      persistence.appendEvent(session.id, {
        seq: 999,
        ts: 999,
        type: 'watchdog_recovery',
        data: { late: true },
      })
    }, 5)

    assert.equal(manager.archiveSession(session.id), true)
    assert.deepEqual(manager.deleteSession(session.id), { ok: true, freedBytes: 1 })

    callbacks.onTextDelta('late text')
    callbacks.onThinkingDelta('late thinking')
    callbacks.onToolUse('late-use', 'bash', { command: 'echo late' })
    callbacks.onTurnComplete({}, 99, true)
    callbacks.onError(new Error('late error'))
    callbacks.onPhaseChange?.('executing', { reason: 'late phase' })
    callbacks.onToolResult('late-plan', 'plan_submit', 'late plan', false)
    callbacks.onToolResult('late-write', 'write_file', 'late write', false)
    await new Promise((resolve) => setTimeout(resolve, 60))

    assert.equal(persistence.appendsAfterDelete, 0)
    assert.equal(persistence.savesAfterDelete, 0)
    assert.equal(persistence.events.has(session.id), false)
    assert.equal(persistence.records.has(session.id), false)
    assert.equal(internal.deltaTimer, undefined)
    assert.equal(internal.deltaBuf, undefined)
    assert.equal(internal.planDraftTimer, undefined)
    assert.equal(internal.watchdogContinueTimer, undefined)
    assert.equal(internal.toolResultTimer, undefined)
    assert.equal(internal.toolResultStream, undefined)
  })

  it('late approval after permanent delete rejects immediately without state or timer creation', async () => {
    const persistence = new MemoryPersistence()
    const { manager, agent, session } = setup({ persistence, approvalTimeoutMs: 20 })
    const callbacks = agent.callbacks!
    const internal = (manager as unknown as {
      sessions: Map<string, { pending: Map<string, unknown> }>
    }).sessions.get(session.id)!

    assert.equal(manager.archiveSession(session.id), true)
    assert.deepEqual(manager.deleteSession(session.id), { ok: true, freedBytes: 1 })
    const approval = callbacks.onApprovalRequired('late-approval', 'bash', { command: 'rm x' })
    assert.equal(internal.pending.size, 0)
    const immediate = await Promise.race([
      approval,
      Promise.resolve('still-pending' as const),
    ])
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.deepEqual(immediate, { approved: false })
    assert.equal(internal.pending.size, 0)
    assert.equal(persistence.appendsAfterDelete, 0)
    assert.equal(persistence.savesAfterDelete, 0)
    assert.equal(persistence.events.has(session.id), false)
    assert.equal(persistence.records.has(session.id), false)
  })

  it('archive-unarchive new run fences callbacks and finalizer from the old run', async () => {
    const persistence = new MemoryPersistence()
    const { manager, agent, session } = setup({ persistence })
    const oldCallbacks = agent.callbackRuns[0]!

    assert.equal(manager.archiveSession(session.id), true)
    assert.equal(manager.unarchiveSession(session.id), true)
    assert.equal(manager.run(session.id, 'too soon'), false)
    agent.finish(0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(manager.run(session.id, 'new run'), true)
    const newCallbacks = agent.callbackRuns[1]!
    const baseline = manager.getEvents(session.id, 0)!.lastSeq
    const internal = (manager as unknown as {
      sessions: Map<string, { pending: Map<string, unknown> }>
    }).sessions.get(session.id)!

    oldCallbacks.onTextDelta('old text')
    oldCallbacks.onThinkingDelta('old thinking')
    oldCallbacks.onToolUse('old-tool', 'bash', { command: 'echo old' })
    oldCallbacks.onToolResult('old-tool', 'bash', 'old result', false)
    oldCallbacks.onTurnComplete({}, 1, true)
    oldCallbacks.onError(new Error('old error'))
    const staleApproval = await Promise.race([
      oldCallbacks.onApprovalRequired('old-approval', 'bash', { command: 'echo old' }),
      Promise.resolve('still-pending' as const),
    ])
    assert.deepEqual(staleApproval, { approved: false })
    assert.equal(internal.pending.size, 0)
    assert.equal(manager.getSession(session.id)?.status, 'running')
    assert.deepEqual(manager.getEvents(session.id, baseline)!.events, [])

    newCallbacks.onTextDelta('new text')
    agent.finish(1)
    await new Promise((resolve) => setImmediate(resolve))
    const events = manager.getEvents(session.id, baseline)!.events
    assert.ok(events.some((event) => event.type === 'text_delta' && event.data.text === 'new text'))
    assert.equal(events.at(-1)?.type, 'done')
    assert.equal(events.at(-1)?.data.status, 'completed')
    assert.equal(manager.getSession(session.id)?.status, 'completed')
  })

  it('fences old plan mode, submitted, draft timer, and async read completion from a new run', async () => {
    const { manager, agent, session, scheduler } = setup()
    const oldCallbacks = agent.callbackRuns[0]!
    const oldPlanModeChange = agent.onPlanModeChange!
    const oldPlans = new Deferred<Array<{
      slug: string
      title: string
      status: 'submitted'
      content: string
      path: string
      createdAt: Date
    }>>()
    const newPlans = new Deferred<Array<{
      slug: string
      title: string
      status: 'submitted'
      content: string
      path: string
      createdAt: Date
    }>>()
    const oldDraft = new Deferred<{ path: string; title: string; content: string } | null>()
    const newDraft = new Deferred<{ path: string; title: string; content: string } | null>()
    const planReads = [oldPlans, newPlans]
    const draftReads = [oldDraft, newDraft]
    const internals = manager as unknown as {
      planEventScheduler: FakeScheduler
      loadPlans: () => Promise<Array<{
        slug: string
        title: string
        status: 'submitted'
        content: string
        path: string
        createdAt: Date
      }>>
      readPlanDraft: () => Promise<{ path: string; title: string; content: string } | null>
    }
    internals.planEventScheduler = scheduler
    internals.loadPlans = () => planReads.shift()!.promise
    internals.readPlanDraft = () => draftReads.shift()!.promise

    oldPlanModeChange('planning')
    oldCallbacks.onToolResult('old-submit', 'plan_submit', 'ok', false)
    oldCallbacks.onToolResult('old-write-1', 'write_file', 'ok', false)
    oldCallbacks.onToolResult('old-write-2', 'write_file', 'ok', false)
    assert.equal(scheduler.size, 1)
    assert.equal(manager.archiveSession(session.id), true)
    assert.equal(scheduler.size, 0)
    assert.equal(manager.unarchiveSession(session.id), true)
    assert.equal(manager.run(session.id, 'too soon'), false)
    agent.finish(0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(manager.run(session.id, 'new run'), true)
    const newCallbacks = agent.callbackRuns[1]!
    const newPlanModeChange = agent.onPlanModeChange!
    const baseline = manager.getEvents(session.id, 0)!.lastSeq

    oldPlanModeChange('off')
    scheduler.runCleared()
    oldPlans.resolve([{
      slug: 'old-plan',
      title: 'Old plan',
      status: 'submitted',
      content: '# Old plan',
      path: '.rivet/plans/old-plan.md',
      createdAt: new Date(0),
    }])
    oldDraft.resolve({
      path: '.rivet/plans/old-draft.md',
      title: 'Old draft',
      content: '# Old draft',
    })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(manager.getSession(session.id)?.planMode, 'planning')
    assert.deepEqual(manager.getEvents(session.id, baseline)!.events, [])

    newPlanModeChange('off')
    newPlanModeChange('planning')
    newCallbacks.onToolResult('new-submit', 'plan_submit', 'ok', false)
    newCallbacks.onToolResult('new-write', 'write_file', 'ok', false)
    newPlans.resolve([{
      slug: 'new-plan',
      title: 'New plan',
      status: 'submitted',
      content: '# New plan',
      path: '.rivet/plans/new-plan.md',
      createdAt: new Date(1),
    }])
    newDraft.resolve({
      path: '.rivet/plans/new-draft.md',
      title: 'New draft',
      content: '# New draft',
    })
    await new Promise((resolve) => setImmediate(resolve))

    const planEvents = manager.getEvents(session.id, baseline)!.events.filter((event) =>
      event.type === 'plan_mode' || event.type === 'plan_submitted' || event.type === 'plan_draft')
    assert.deepEqual(planEvents.map((event) => [event.type, event.data.state ?? event.data.slug ?? event.data.path]), [
      ['plan_mode', 'off'],
      ['plan_mode', 'planning'],
      ['plan_submitted', 'new-plan'],
      ['plan_draft', '.rivet/plans/new-draft.md'],
    ])
  })

  it('keeps abort settlement busy and gates resubmit, model switch, rewind, and claims', async () => {
    let releaseCalls = 0
    const registry = {
      register() {},
      heartbeat() {},
      releaseAllClaims() { releaseCalls++ },
    }
    const { manager, agent, session } = setup({
      getSessionRegistry: () => registry as never,
    })

    assert.equal(manager.abort(session.id), true)
    assert.equal(manager.run(session.id, 'too soon'), false)
    assert.equal(await manager.switchModel(session.id, 'other-model'), false)
    assert.equal(manager.rewind(session.id, 0), false)
    assert.equal(agent.concurrentRunAttempts, 0)
    assert.equal(agent.switchModelCalls, 0)
    assert.equal(agent.rewindCalls, 0)
    assert.equal(releaseCalls, 0)

    agent.finish(0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(releaseCalls, 1)
    assert.equal(manager.run(session.id, 'after settlement'), true)
    assert.equal(agent.callbackRuns.length, 2)
    agent.finish(1)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(releaseCalls, 2)
  })

  it('keeps archive-unarchive busy until settlement and releases tombstoned claims once', async () => {
    let releaseCalls = 0
    const registry = {
      register() {},
      heartbeat() {},
      releaseAllClaims() { releaseCalls++ },
    }
    const first = setup({ getSessionRegistry: () => registry as never })

    assert.equal(first.manager.archiveSession(first.session.id), true)
    assert.equal(first.manager.unarchiveSession(first.session.id), true)
    assert.equal(first.manager.run(first.session.id, 'too soon'), false)
    assert.equal(await first.manager.switchModel(first.session.id, 'other-model'), false)
    assert.equal(first.manager.rewind(first.session.id, 0), false)
    assert.equal(first.agent.concurrentRunAttempts, 0)
    assert.equal(releaseCalls, 0)

    first.agent.finish(0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(releaseCalls, 1)
    assert.equal(first.manager.run(first.session.id, 'after settlement'), true)
    first.agent.finish(1)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(releaseCalls, 2)

    const deleted = setup({ getSessionRegistry: () => registry as never })
    const internal = (deleted.manager as unknown as {
      sessions: Map<string, { running: boolean }>
    }).sessions.get(deleted.session.id)!
    assert.equal(deleted.manager.archiveSession(deleted.session.id), true)
    assert.deepEqual(deleted.manager.deleteSession(deleted.session.id), { ok: true, freedBytes: 0 })
    assert.equal(releaseCalls, 3)
    deleted.agent.finish(0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(internal.running, false)
    assert.equal(releaseCalls, 3)
  })
})
