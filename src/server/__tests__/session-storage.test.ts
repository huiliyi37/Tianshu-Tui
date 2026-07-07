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

/** In-memory store with storage-management methods + a per-session size table. */
class StorageMemPersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  sizes = new Map<string, number>()
  deleted: string[] = []

  saveRecord(r: SessionRecord): void { this.records.set(r.id, { ...r }) }
  appendEvent(id: string, e: SessionEvent): void {
    const a = this.events.get(id) ?? []
    a.push(e)
    this.events.set(id, a)
  }
  loadAll(): PersistedSession[] { return [] }
  loadRecords(): SessionRecord[] { return [...this.records.values()].map((r) => ({ ...r })) }
  loadEvents(id: string): SessionEvent[] { return (this.events.get(id) ?? []).map((e) => ({ ...e })) }
  sizeReport(): Map<string, number> { return new Map(this.sizes) }
  sizeOf(id: string): number { return this.sizes.get(id) ?? 0 }
  deleteSession(id: string): void {
    this.deleted.push(id)
    this.records.delete(id)
    this.events.delete(id)
    this.sizes.delete(id)
  }
}

function makeManager() {
  const mem = new StorageMemPersistence()
  let n = 0
  let t = 1000
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
    now: () => t,
    idGenerator: () => `s${++n}`,
  })
  return { mem, mgr, setTime: (v: number) => { t = v } }
}

test('storageReport totals usage and lists only archived (oldest first)', () => {
  const { mem, mgr, setTime } = makeManager()
  mgr.createSession({ title: 'A' }) // s1 active
  mgr.createSession({ title: 'B' }) // s2
  mgr.createSession({ title: 'C' }) // s3
  mem.sizes.set('s1', 100)
  mem.sizes.set('s2', 200)
  mem.sizes.set('s3', 400)
  setTime(5000); mgr.archiveSession('s3')
  setTime(2000); mgr.archiveSession('s2')

  const rep = mgr.storageReport()
  assert.equal(rep.totalBytes, 700)
  assert.equal(rep.sessionCount, 3)
  assert.equal(rep.archivedCount, 2)
  assert.equal(rep.archivedBytes, 600)
  assert.deepEqual(rep.archived.map((a) => a.id), ['s2', 's3'], 'oldest updatedAt first')
  assert.equal(rep.archived[0]!.bytes, 200)
})

test('purgeArchived deletes all archived, leaves active, reports freed bytes', () => {
  const { mem, mgr, setTime } = makeManager()
  mgr.createSession({}) // s1 active
  mgr.createSession({}) // s2
  mem.sizes.set('s1', 100)
  mem.sizes.set('s2', 200)
  setTime(3000); mgr.archiveSession('s2')

  const res = mgr.purgeArchived()
  assert.equal(res.deleted, 1)
  assert.equal(res.freedBytes, 200)
  assert.deepEqual(res.ids, ['s2'])
  assert.deepEqual(mem.deleted, ['s2'], 'disk delete invoked')
  assert.equal(mgr.getSession('s2'), undefined, 'removed from memory')
  assert.ok(mgr.getSession('s1'), 'active session untouched')
})

test('purgeArchived olderThanMs keeps recently-archived sessions', () => {
  const { mem, mgr, setTime } = makeManager()
  mgr.createSession({}) // s1
  mgr.createSession({}) // s2
  mem.sizes.set('s1', 100)
  mem.sizes.set('s2', 100)
  setTime(1_000); mgr.archiveSession('s1') // old
  setTime(9_000); mgr.archiveSession('s2') // recent
  // now=9000; threshold 3000ms → s1 age 8000 (purge), s2 age 0 (keep)
  const res = mgr.purgeArchived({ olderThanMs: 3000 })
  assert.deepEqual(res.ids, ['s1'])
  assert.ok(mgr.getSession('s2'), 'recently archived session retained')
})

test('deleteSession refuses non-archived, removes archived', () => {
  const { mem, mgr, setTime } = makeManager()
  mgr.createSession({}) // s1 active
  mem.sizes.set('s1', 123)

  assert.deepEqual(mgr.deleteSession('s1'), { ok: false, freedBytes: 0 }, 'active session protected')

  setTime(2000); mgr.archiveSession('s1')
  const res = mgr.deleteSession('s1')
  assert.equal(res.ok, true)
  assert.equal(res.freedBytes, 123)
  assert.deepEqual(mem.deleted, ['s1'])
  assert.equal(mgr.getSession('s1'), undefined)
})
