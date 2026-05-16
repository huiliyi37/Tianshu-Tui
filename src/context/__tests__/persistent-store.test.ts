import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PersistentStore } from '../persistent-store.js'

describe('PersistentStore', () => {
  let dir: string
  let store: PersistentStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-ps-'))
    store = new PersistentStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('archives and retrieves tool result by id', () => {
    const id = store.archive({
      toolName: 'read_file',
      content: 'file contents here',
      sessionId: 'sess-1',
      roundNumber: 5,
    })
    const retrieved = store.retrieve(id)

    assert.equal(retrieved?.content, 'file contents here')
    assert.equal(retrieved?.toolName, 'read_file')
  })

  it('searches by tool name', () => {
    store.archive({ toolName: 'bash', content: 'npm test output', sessionId: 's', roundNumber: 1 })
    store.archive({ toolName: 'read_file', content: 'src/main.tsx', sessionId: 's', roundNumber: 2 })
    const results = store.search({ toolName: 'bash', limit: 5 })

    assert.equal(results.length, 1)
    assert.match(results[0]?.content ?? '', /npm test/)
  })

  it('respects disk limit', () => {
    store = new PersistentStore(dir, { maxDiskBytes: 100 })
    store.archive({ toolName: 'bash', content: 'x'.repeat(200), sessionId: 's', roundNumber: 1 })
    const all = store.search({ limit: 100 })

    assert.ok(all.length <= 1)
  })
})
