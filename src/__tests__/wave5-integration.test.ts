import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
import { FileHistory } from '../agent/file-history.js'
import { persistFileHistory, loadFileHistory } from '../agent/file-history-persist.js'
import { createContextLedger } from '../context/ledger.js'
import type { ContextAnchor } from '../context/types.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Wave 5 integration', () => {
  it('default registry includes repo_map, inspect_project, related_tests', () => {
    const reg = createDefaultToolRegistry()
    const defs = reg.getDefinitions()
    const names = defs.map(d => d.name)
    assert.ok(names.includes('repo_map'))
    assert.ok(names.includes('inspect_project'))
    assert.ok(names.includes('related_tests'))
    assert.ok(names.includes('apply_patch'))
  })

  it('persistFileHistory round-trips entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-w5-'))
    try {
      const entries = [
        { messageId: 'msg-1', files: [{ path: '/a.ts', content: 'x' }], timestamp: 1 },
        { messageId: 'msg-2', files: [{ path: '/b.ts', content: 'y' }], timestamp: 2 },
      ]
      const filePath = join(dir, 'fh.json')
      persistFileHistory(filePath, entries)
      const loaded = loadFileHistory(filePath)
      assert.equal(loaded.length, 2)
      assert.equal(loaded[0]!.messageId, 'msg-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persistFileHistory caps at maxSnapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-w5-'))
    try {
      const entries = Array.from({ length: 60 }, (_, i) => ({
        messageId: `msg-${i}`,
        files: [{ path: '/a.ts', content: `v${i}` }],
        timestamp: i,
      }))
      const filePath = join(dir, 'fh.json')
      persistFileHistory(filePath, entries, 50)
      const loaded = loadFileHistory(filePath)
      assert.equal(loaded.length, 50)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('FileHistory can be created and tracks edits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-w5-'))
    try {
      const fh = new FileHistory(dir, 'test-session')
      const testFile = join(dir, 'test.txt')
      writeFileSync(testFile, 'hello')
      await fh.trackEdit(testFile, 'msg-1')
      assert.ok(fh.hasSnapshot('msg-1'))
      assert.equal(fh.getLatestSnapshotId(), 'msg-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('createContextLedger includes extraAnchors', () => {
    const anchors: ContextAnchor[] = [
      { kind: 'user_preference', text: 'use postgres', sourceRoundIndex: -1, salience: 1.0 },
    ]
    const ledger = createContextLedger('test', '/tmp/test', [], 128000, undefined, anchors)
    assert.equal(ledger.anchors.length, 1)
    assert.equal(ledger.anchors[0]!.text, 'use postgres')
    assert.equal(ledger.anchors[0]!.kind, 'user_preference')
  })

  it('createContextLedger defaults anchors to empty when no extraAnchors', () => {
    const ledger = createContextLedger('test', '/tmp/test', [], 128000)
    assert.deepEqual(ledger.anchors, [])
  })
})
