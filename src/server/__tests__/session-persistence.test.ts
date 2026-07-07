import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionPersistence } from '../session-persistence.js'
import type { SessionEvent, SessionRecord } from '../session-manager.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-persist-'))
}

function rec(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    cwd: '/work',
    lastSeq: 0,
    pendingApprovals: 0,
    ...over,
  }
}

function ev(seq: number, type: SessionEvent['type'] = 'text_delta'): SessionEvent {
  return { seq, ts: 100 + seq, type, data: { text: `e${seq}` } }
}

test('round-trips record + events', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1'))
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(2))
    const all = p.loadAll()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.record.id, 's1')
    assert.equal(all[0]!.events.length, 2)
    assert.deepEqual(all[0]!.events.map((e) => e.seq), [1, 2])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt trailing line is dropped, not fatal', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1'))
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(2))
    // Events are write-buffered (100ms debounce) — flush so they hit disk
    // BEFORE the corruption is injected, mirroring a crash after a clean batch.
    p.flushSync()
    // Simulate a crash mid-write: a half-written final line.
    appendFileSync(join(dir, 's1', 'events.jsonl'), '{"seq":3,"ts":1,"type":"tex')
    const all = p.loadAll()
    assert.equal(all[0]!.events.length, 2, 'partial line must be skipped')
    assert.equal(all[0]!.events[1]!.seq, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('events are sorted by seq; seq does not regress', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1'))
    p.appendEvent('s1', ev(2))
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(3))
    const evs = p.loadAll()[0]!.events
    assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing index.json is reconstructed from event tail', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    // Write only events (no saveRecord) — simulate a record that never flushed.
    p.appendEvent('s9', ev(1))
    p.appendEvent('s9', ev(2))
    const all = p.loadAll()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.record.id, 's9')
    assert.equal(all[0]!.record.lastSeq, 2)
    assert.equal(all[0]!.record.status, 'aborted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveRecord is atomic (no stray tmp left behind)', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1', { status: 'completed' }))
    const files = readdirSync(join(dir, 's1'))
    assert.ok(files.includes('index.json'))
    assert.ok(!files.includes('index.json.tmp'), 'tmp file must be renamed away')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt index.json falls back to event reconstruction', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.appendEvent('s1', ev(5))
    // Flush the write buffer so the session dir exists on disk before the
    // corrupt index.json is planted.
    p.flushSync()
    writeFileSync(join(dir, 's1', 'index.json'), '{ not json', 'utf8')
    const all = p.loadAll()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.record.lastSeq, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
