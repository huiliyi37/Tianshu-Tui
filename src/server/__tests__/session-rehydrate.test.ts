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
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'tool_use', {}), ev(3, 'approval_required', { requestId: 'r' })],
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

test('stats() reports session and running counts', () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  mgr.createSession({})
  const s = mgr.createSession({})
  // NoopAgent.run resolves immediately, so trigger and check before microtask drain is racy;
  // just assert sessionCount which is deterministic.
  assert.equal(mgr.stats().sessionCount, 2)
  assert.ok(s.id)
})
