import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type PersistedSession,
  type SessionEvent,
  type SessionPersistenceAdapter,
  type SessionRecord,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

class NoopAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** In-memory persistence so the rehydrate path can be tested without disk. */
class MemoryPersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  saved: PersistedSession[] = []

  constructor(seed: PersistedSession[] = []) {
    this.saved = seed
  }
  saveRecord(record: SessionRecord): void { this.records.set(record.id, record) }
  appendEvent(id: string, event: SessionEvent): void {
    const arr = this.events.get(id) ?? []
    arr.push(event)
    this.events.set(id, arr)
  }
  loadAll(): PersistedSession[] { return this.saved }
}

/**
 * Lazy adapter: implements loadRecords()/loadEvents() so the manager exercises
 * the lazy-boot path. Counts loadEvents() calls so tests can assert the log is
 * read on demand (first open) and re-read after an LRU eviction — never at boot.
 */
class LazyMemoryPersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  loadEventsCalls: string[] = []

  constructor(seed: PersistedSession[] = []) {
    for (const s of seed) {
      this.records.set(s.record.id, s.record)
      this.events.set(s.record.id, s.events.slice())
    }
  }
  saveRecord(record: SessionRecord): void { this.records.set(record.id, { ...record }) }
  appendEvent(id: string, event: SessionEvent): void {
    const arr = this.events.get(id) ?? []
    arr.push(event)
    this.events.set(id, arr)
  }
  loadAll(): PersistedSession[] {
    return [...this.records.values()].map((r) => ({ record: r, events: this.events.get(r.id) ?? [] }))
  }
  loadRecords(): SessionRecord[] { return [...this.records.values()].map((r) => ({ ...r })) }
  loadEvents(id: string): SessionEvent[] {
    this.loadEventsCalls.push(id)
    return (this.events.get(id) ?? []).map((e) => ({ ...e }))
  }
}

function ev(seq: number, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent {
  return { seq, ts: 100 + seq, type, data }
}

test('rehydrate restores sessions and replays their event tail', () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'old1', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'text_delta', { text: 'hi' })],
  }]
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new MemoryPersistence(seed),
  })

  const list = mgr.listSessions()
  assert.equal(list.length, 1)
  assert.equal(list[0]!.id, 'old1')
  assert.equal(list[0]!.status, 'completed')

  const replay = mgr.getEvents('old1', 0)!
  assert.equal(replay.events.length, 2)
  assert.equal(replay.lastSeq, 2)
})

test('a session that was running becomes aborted with an honest marker', () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'crash', status: 'running', createdAt: 1, updatedAt: 5,
      cwd: '/work', lastSeq: 3, pendingApprovals: 1,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'tool_use', {}), ev(3, 'approval_required', { requestId: 'r', toolName: 'bash' })],
  }]
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new MemoryPersistence(seed),
  })

  const rec = mgr.getSession('crash')!
  assert.equal(rec.status, 'aborted', 'interrupted run restored as aborted')
  assert.equal(rec.pendingApprovals, 0, 'no live pending interventions after restart')

  // A marker event was appended (seq continues past the loaded tail).
  const evs = mgr.getEvents('crash', 0)!.events
  const marker = evs.find((e) => e.type === 'status' && e.data.reason === 'sidecar-restart')
  assert.ok(marker, 'restart marker event recorded')
  assert.ok(marker!.seq > 3, 'seq does not regress')

  // The dangling approval is closed out honestly (eager path scans in memory).
  const closed = evs.find((e) => e.type === 'approval_resolved' && e.data.requestId === 'r')
  assert.ok(closed, 'dangling approval closed out')
  assert.equal(closed!.data.decision, 'sidecar-restart')
  assert.equal(closed!.data.toolName, 'bash')
  assert.deepEqual(marker!.data.interruptedApprovals, [{ requestId: 'r', toolName: 'bash' }])
})

test('new events after rehydrate are persisted via the adapter', () => {
  const mem = new MemoryPersistence()
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })
  const s = mgr.createSession({})
  assert.ok(mem.records.has(s.id), 'record persisted on create')
  mgr.run(s.id, 'go')
  const persistedEvents = mem.events.get(s.id) ?? []
  assert.ok(persistedEvents.some((e) => e.type === 'status'), 'run status event persisted')
})

test('rehydrated session with a prior conversation warns when the model context restore came back empty', () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'lost', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'user', { text: 'earlier question' }), ev(2, 'text_delta', { text: 'earlier answer' })],
  }]
  // Agent whose boot-time history restore found nothing (corrupt/missing .jsonl).
  class AmnesiacAgent extends NoopAgent {
    getHistoryRestore(): { restored: number; error?: string } {
      return { restored: 0, error: 'EISDIR: illegal operation' }
    }
  }
  const mgr = new RuntimeSessionManager({
    createAgent: () => new AmnesiacAgent(),
    persistence: new MemoryPersistence(seed),
  })

  mgr.run('lost', 'follow-up')
  const evs = mgr.getEvents('lost', 0)!.events
  const warn = evs.find((e) => e.type === 'phase' && String(e.data.phase).includes('历史上下文'))
  assert.ok(warn, 'timeline carries a visible history-lost warning')
  assert.deepEqual(warn!.data.historyRestore, { restored: 0, error: 'EISDIR: illegal operation' })
})

test('no history-lost warning when the restore succeeded or the session had no conversation', () => {
  const seed: PersistedSession[] = [
    {
      record: { id: 'ok', status: 'completed', createdAt: 1, updatedAt: 9, cwd: '/work', lastSeq: 1, pendingApprovals: 0 },
      events: [ev(1, 'user', { text: 'hello' })],
    },
    {
      record: { id: 'fresh', status: 'idle', createdAt: 1, updatedAt: 9, cwd: '/work', lastSeq: 0, pendingApprovals: 0 },
      events: [],
    },
  ]
  class RestoredAgent extends NoopAgent {
    getHistoryRestore(): { restored: number } { return { restored: 5 } }
  }
  class EmptyAgent extends NoopAgent {
    getHistoryRestore(): { restored: number } { return { restored: 0 } }
  }
  const mgrOk = new RuntimeSessionManager({
    createAgent: () => new RestoredAgent(),
    persistence: new MemoryPersistence(seed),
  })
  mgrOk.run('ok', 'more')
  assert.ok(
    !mgrOk.getEvents('ok', 0)!.events.some((e) => e.type === 'phase' && String(e.data.phase).includes('历史上下文')),
    'successful restore → no warning',
  )

  const mgrFresh = new RuntimeSessionManager({
    createAgent: () => new EmptyAgent(),
    persistence: new MemoryPersistence(seed),
  })
  mgrFresh.run('fresh', 'first prompt')
  assert.ok(
    !mgrFresh.getEvents('fresh', 0)!.events.some((e) => e.type === 'phase' && String(e.data.phase).includes('历史上下文')),
    'no prior conversation → restored=0 is normal, no warning',
  )
})

test('lazy rehydrate reads no event logs at boot, loads on first open', () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'a', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'text_delta', { text: 'hi' })],
  }]
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  // Boot scanned records only — the (potentially huge) event log is untouched.
  assert.equal(mem.loadEventsCalls.length, 0, 'no event-log read at boot')
  assert.equal(mgr.listSessions().length, 1, 'session listed from index record alone')

  // First open lazily materializes the log.
  const replay = mgr.getEvents('a', 0)!
  assert.deepEqual(mem.loadEventsCalls, ['a'])
  assert.equal(replay.events.length, 2)
  assert.equal(replay.lastSeq, 2)

  // Re-open is a no-op against disk (already resident).
  mgr.getEvents('a', 0)
  assert.deepEqual(mem.loadEventsCalls, ['a'], 'resident log is not re-read')
})

test('lazy rehydrate caps resident logs (LRU) and reloads evicted ones', () => {
  const seed: PersistedSession[] = ['s1', 's2', 's3'].map((id, i) => ({
    record: {
      id, status: 'completed' as const, createdAt: 1, updatedAt: i,
      cwd: '/work', lastSeq: 1, pendingApprovals: 0,
    },
    events: [ev(1, 'text_delta', { text: id })],
  }))
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
    maxLoadedSessions: 2,
  })

  mgr.getEvents('s1', 0)
  mgr.getEvents('s2', 0)
  mgr.getEvents('s3', 0) // exceeds cap → evicts LRU (s1), still on disk
  assert.deepEqual(mem.loadEventsCalls, ['s1', 's2', 's3'])

  // Re-opening the evicted session reloads it from disk (proves it was dropped).
  const replay = mgr.getEvents('s1', 0)!
  assert.deepEqual(mem.loadEventsCalls, ['s1', 's2', 's3', 's1'], 's1 reloaded after eviction')
  assert.equal(replay.events.length, 1)
})

test('lazy load applies the memory ring cap: only the tail stays resident', () => {
  const total = 250
  const cap = 100
  const events: SessionEvent[] = []
  // An artifact event in the head that the cap will truncate — its id must
  // still land in knownArtifacts (dedup built from the full log before trim).
  events.push(ev(1, 'artifact', { id: 'old-art' }))
  for (let i = 2; i <= total; i++) events.push(ev(i, 'text_delta', { text: `e${i}` }))
  const seed: PersistedSession[] = [{
    record: {
      id: 'long', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: total, pendingApprovals: 0,
    },
    events,
  }]
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
    maxEvents: cap,
  })

  const replay = mgr.getEvents('long', 0)!
  assert.equal(replay.events.length, cap, 'since=0 replay returns at most maxEvents')
  assert.equal(replay.events[0]!.seq, total - cap + 1, 'resident window is the tail')
  assert.equal(replay.events[replay.events.length - 1]!.seq, total)
  assert.equal(replay.lastSeq, total, 'lastSeq reflects the full on-disk log, not the trimmed window')
})

test('eager fallback rehydrate applies the same memory ring cap', () => {
  const total = 250
  const cap = 100
  const events: SessionEvent[] = []
  for (let i = 1; i <= total; i++) events.push(ev(i, 'text_delta', { text: `e${i}` }))
  const seed: PersistedSession[] = [{
    record: {
      id: 'long', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: total, pendingApprovals: 0,
    },
    events,
  }]
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new MemoryPersistence(seed),
    maxEvents: cap,
  })

  const replay = mgr.getEvents('long', 0)!
  assert.equal(replay.events.length, cap)
  assert.equal(replay.events[0]!.seq, total - cap + 1)
  assert.equal(replay.lastSeq, total)
})

test('lazy rehydrate flags an interrupted run aborted without reading the log', () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'crash', status: 'running', createdAt: 1, updatedAt: 5,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'tool_use', {})],
  }]
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  // The restart marker is appended straight to disk — no event-log read at boot
  // (only crashed-with-pending-approvals sessions pay a gated log read).
  assert.equal(mem.loadEventsCalls.length, 0, 'no event-log read for the abort marker')
  const rec = mgr.getSession('crash')!
  assert.equal(rec.status, 'aborted')
  assert.equal(rec.pendingApprovals, 0)
  const marker = (mem.events.get('crash') ?? []).find(
    (e) => e.type === 'status' && (e.data as { reason?: string }).reason === 'sidecar-restart',
  )
  assert.ok(marker, 'restart marker persisted')
  assert.ok(marker!.seq > 2, 'seq does not regress')
})

test('lazy rehydrate closes out approvals the crash left dangling', () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'crash', status: 'running', createdAt: 1, updatedAt: 5,
      cwd: '/work', lastSeq: 4, pendingApprovals: 1,
    },
    events: [
      ev(1, 'status', { status: 'running' }),
      // An earlier approval that WAS answered — must not be re-closed.
      ev(2, 'approval_required', { requestId: 'done', toolName: 'read_file' }),
      ev(3, 'approval_resolved', { requestId: 'done', decision: 'approve' }),
      ev(4, 'approval_required', { requestId: 'r1', toolName: 'bash' }),
    ],
  }]
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  // The pendingApprovals>0 gate allows exactly one log read for this session.
  assert.deepEqual(mem.loadEventsCalls, ['crash'])

  const rec = mgr.getSession('crash')!
  assert.equal(rec.status, 'aborted')
  assert.equal(rec.pendingApprovals, 0)

  const persisted = mem.events.get('crash') ?? []
  const closed = persisted.filter(
    (e) => e.type === 'approval_resolved' && (e.data as { decision?: string }).decision === 'sidecar-restart',
  )
  assert.equal(closed.length, 1, 'only the dangling approval is closed out')
  assert.equal(closed[0]!.data.requestId, 'r1')
  assert.equal(closed[0]!.data.toolName, 'bash')
  assert.ok(closed[0]!.seq > 4, 'seq does not regress')

  const marker = persisted.find(
    (e) => e.type === 'status' && (e.data as { reason?: string }).reason === 'sidecar-restart',
  )
  assert.ok(marker, 'restart marker persisted')
  assert.deepEqual(marker!.data.interruptedApprovals, [{ requestId: 'r1', toolName: 'bash' }])
  assert.ok(marker!.seq > closed[0]!.seq, 'resolution precedes the status marker')

  // The replayed timeline includes the closure — no dangling approval card.
  const replay = mgr.getEvents('crash', 0)!.events
  assert.ok(replay.some(
    (e) => e.type === 'approval_resolved' && e.data.requestId === 'r1' && e.data.decision === 'sidecar-restart',
  ))
})

test('requestApproval persists pendingApprovals so the rehydrate gate sees it', () => {
  class CaptureAgent extends NoopAgent {
    callbacks?: AgentCallbacks
    override run(_p: string, cb: AgentCallbacks): Promise<void> {
      this.callbacks = cb
      return new Promise(() => { /* stays running (blocked on approval) */ })
    }
  }
  const mem = new LazyMemoryPersistence()
  const agent = new CaptureAgent()
  const mgr = new RuntimeSessionManager({
    createAgent: () => agent,
    persistence: mem,
  })
  const s = mgr.createSession({ prompt: 'go' })
  void agent.callbacks!.onApprovalRequired('t1', 'bash', { command: 'ls' })

  // The on-disk record reflects the pending approval at request time — this is
  // the crash-safety property the rehydrate gate relies on.
  assert.equal(mem.records.get(s.id)!.pendingApprovals, 1)

  mgr.answerIntervention(s.id, 't1', 'reject')
  assert.equal(mem.records.get(s.id)!.pendingApprovals, 0)
})

test('stats() reports session and running counts', () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  mgr.createSession({})
  const s = mgr.createSession({})
  // NoopAgent.run resolves immediately, so trigger and check before microtask drain is racy;
  // just assert sessionCount which is deterministic.
  assert.equal(mgr.stats().sessionCount, 2)
  assert.ok(s.id)
})
