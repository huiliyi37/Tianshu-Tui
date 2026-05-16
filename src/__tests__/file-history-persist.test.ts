import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { persistFileHistory, loadFileHistory } from '../agent/file-history-persist.js'

describe('FileHistory persistence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rivet-fh-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('round-trips snapshots to JSON', () => {
    const snapshots = [
      { messageId: 'msg-1', files: [{ path: '/a.ts', content: 'const x = 1' }], timestamp: Date.now() },
      { messageId: 'msg-2', files: [{ path: '/a.ts', content: 'const x = 2' }], timestamp: Date.now() },
    ]
    const filePath = join(dir, 'file-history.json')
    persistFileHistory(filePath, snapshots)
    const loaded = loadFileHistory(filePath)
    assert.deepEqual(loaded, snapshots)
  })

  it('caps at maxSnapshots via ring buffer GC', () => {
    const snapshots = Array.from({ length: 60 }, (_, i) => ({
      messageId: `msg-${i}`,
      files: [{ path: '/a.ts', content: `v${i}` }],
      timestamp: Date.now() + i,
    }))
    const filePath = join(dir, 'file-history.json')
    persistFileHistory(filePath, snapshots, 50)
    const loaded = loadFileHistory(filePath)
    assert.equal(loaded.length, 50)
    assert.equal(loaded[0]!.messageId, 'msg-10')
  })

  it('returns empty array for missing file', () => {
    const loaded = loadFileHistory(join(dir, 'nonexistent.json'))
    assert.deepEqual(loaded, [])
  })

  it('returns empty array for corrupt JSON', () => {
    const filePath = join(dir, 'corrupt.json')
    writeFileSync(filePath, 'not valid json{{{')
    const loaded = loadFileHistory(filePath)
    assert.deepEqual(loaded, [])
  })
})
