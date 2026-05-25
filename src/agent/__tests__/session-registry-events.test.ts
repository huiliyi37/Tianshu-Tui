import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SessionRegistry } from '../session-registry.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('SessionRegistry events', () => {
  let registry: SessionRegistry
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reg-events-test-'))
    registry = await SessionRegistry.create(tmpDir)
  })

  afterEach(() => {
    registry.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('publishEvent inserts and consumeEvents reads', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/foo.ts',
      detail: 'Modified function bar',
      priority: 0,
    })

    const events = registry.consumeEvents('session-b', 0)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.sessionId, 'session-a')
    assert.equal(events[0]!.eventType, 'file_changed')
    assert.equal(events[0]!.filePath, 'src/foo.ts')
    assert.equal(events[0]!.detail, 'Modified function bar')
  })

  test('consumeEvents excludes own session events', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/foo.ts',
      detail: 'test',
      priority: 0,
    })

    const events = registry.consumeEvents('session-a', 0)
    assert.equal(events.length, 0)
  })

  test('consumeEvents returns only events after lastSeenId', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/a.ts',
      detail: 'first',
      priority: 0,
    })
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/b.ts',
      detail: 'second',
      priority: 0,
    })

    const all = registry.consumeEvents('session-b', 0)
    assert.equal(all.length, 2)

    const afterFirst = registry.consumeEvents('session-b', all[0]!.id)
    assert.equal(afterFirst.length, 1)
    assert.equal(afterFirst[0]!.filePath, 'src/b.ts')
  })

  test('cleanupOldEvents removes expired entries', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/old.ts',
      detail: 'old event',
      priority: 0,
    })

    // Manually backdate the event
    ;(registry as any).db.prepare(
      "UPDATE events SET created_at = datetime('now', '-3 hours')"
    ).run()

    const removed = registry.cleanupOldEvents(2 * 60 * 60 * 1000) // 2h TTL
    assert.equal(removed, 1)

    const events = registry.consumeEvents('session-b', 0)
    assert.equal(events.length, 0)
  })

  test('consumeEvents returns in id order (priority sorting done in-memory)', () => {
    registry.register('session-a', '/tmp', 'standalone')
    registry.publishEvent('session-a', {
      eventType: 'file_changed',
      filePath: 'src/normal.ts',
      detail: 'normal',
      priority: 0,
    })
    registry.publishEvent('session-a', {
      eventType: 'type_error',
      filePath: 'src/urgent.ts',
      detail: 'Type error: expected 3 args',
      priority: 1,
    })

    const events = registry.consumeEvents('session-b', 0)
    // SQL returns in id ASC order (insertion order)
    assert.equal(events[0]!.filePath, 'src/normal.ts')
    assert.equal(events[1]!.filePath, 'src/urgent.ts')
    assert.equal(events[1]!.priority, 1)
  })
})