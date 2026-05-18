import { describe, it, beforeEach, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionPersist, evictOldSessionsInternal } from '../session-persist.js'

describe('SessionPersist', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('creates a claim store for the session', () => {
    const persist = new SessionPersist('test-session-001')
    const store = persist.createClaimStore()
    assert.ok(store)
    assert.equal(typeof store.propose, 'function')
    assert.equal(typeof store.listActiveClaims, 'function')
  })

  it('buildMemoryBlock returns string for fresh session', () => {
    const persist = new SessionPersist('test-session-002')
    const block = persist.buildMemoryBlock()
    assert.equal(typeof block, 'string')
  })

  it('getSessionMemoryState returns undefined for fresh session', () => {
    const persist = new SessionPersist('test-session-003')
    const state = persist.getSessionMemoryState()
    assert.equal(state, undefined)
  })

  it('injectDurableClaims does not throw on fresh store', () => {
    const persist = new SessionPersist('test-session-004')
    const store = persist.createClaimStore()
    assert.doesNotThrow(() => persist.injectDurableClaims(store))
  })

  it('getBackupDir returns a path containing the session id', () => {
    const persist = new SessionPersist('test-session-005')
    const dir = persist.getBackupDir()
    assert.equal(typeof dir, 'string')
    assert.ok(dir.includes('test-session-005'))
  })
})

describe('TurnSnapshot', () => {
  let tmpDir: string

  before(() => {
    tmpDir = join(tmpdir(), `rivet-snap-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    process.env.RIVET_SESSION_DIR = tmpDir
  })

  after(() => {
    delete process.env.RIVET_SESSION_DIR
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes and reads turn snapshots', () => {
    const persist = new SessionPersist('snap-test-1')

    persist.appendTurnSnapshot({ turn: 1, timestamp: 1000, messageCount: 3, estimatedTokens: 500 })
    persist.appendTurnSnapshot({ turn: 2, timestamp: 2000, messageCount: 6, estimatedTokens: 1000 })

    const last = persist.loadLastSnapshot()
    assert.deepStrictEqual(last, { turn: 2, timestamp: 2000, messageCount: 6, estimatedTokens: 1000 })
  })

  it('returns null when no snapshots exist', () => {
    const persist = new SessionPersist('snap-empty')
    assert.equal(persist.loadLastSnapshot(), null)
  })

  it('skips corrupted snapshot lines', () => {
    const persist = new SessionPersist('snap-corrupt')

    persist.appendTurnSnapshot({ turn: 1, timestamp: 1000, messageCount: 3, estimatedTokens: 500 })
    writeFileSync((persist as any).snapshotPath, 'corrupted\n', { flag: 'a' })
    persist.appendTurnSnapshot({ turn: 3, timestamp: 3000, messageCount: 9, estimatedTokens: 1500 })

    const last = persist.loadLastSnapshot()
    assert.deepStrictEqual(last, { turn: 3, timestamp: 3000, messageCount: 9, estimatedTokens: 1500 })
  })

  it('loads messages up to a specific turn', async () => {
    const persist = new SessionPersist('snap-turn')

    await persist.append({ role: 'user', content: 'turn 1' } as any)
    await persist.append({ role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] } as any)
    await persist.append({ role: 'user', content: 'turn 2' } as any)
    await persist.append({ role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] } as any)
    await persist.append({ role: 'user', content: 'turn 3' } as any)
    await persist.append({ role: 'assistant', content: [{ type: 'text', text: 'reply 3' }] } as any)

    const upTo2 = persist.loadUpToTurn(2)
    const userTurns = upTo2.filter((m: any) => m.role === 'user' && typeof m.content === 'string')
    assert.equal(userTurns.length, 2)
  })

  it('loadRecoverableMessages inserts synthetic tool_result for orphan tool_use', async () => {
    const persist = new SessionPersist('test-session-recoverable-orphan')
    await persist.append({ role: 'user', content: 'run a tool' })
    await persist.append({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } }],
    })

    const result = persist.loadRecoverableMessages()

    assert.equal(result.usedSnapshot, false)
    assert.equal(result.preflight.repaired, true)
    assert.equal(result.preflight.syntheticResultsInserted, 1)
    assert.equal(result.messages.length, 3)
    assert.deepEqual(result.messages[2], {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: '[recovered] Tool result missing after interrupted session resume.',
        is_error: true,
      }],
    })
  })

  it('loadRecoverableMessages rolls back to last snapshot when transcript is unsafe', async () => {
    const persist = new SessionPersist('test-session-recoverable-snapshot')
    await persist.append({ role: 'user', content: 'first turn' })
    await persist.append({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
    persist.appendTurnSnapshot({ turn: 1, timestamp: 2, messageCount: 2, estimatedTokens: 20 })
    await persist.append({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'missing_toolu', content: 'orphan' }],
    })

    const result = persist.loadRecoverableMessages()

    assert.equal(result.usedSnapshot, true)
    assert.equal(result.snapshotTurn, 1)
    assert.equal(result.messages.length, 1)
    assert.deepEqual(result.messages[0], { role: 'user', content: 'first turn' })
  })
})

describe('SessionEviction', () => {
  let evictDir: string

  before(() => {
    evictDir = join(tmpdir(), `rivet-evict-test-${Date.now()}`)
    mkdirSync(evictDir, { recursive: true })
  })

  after(() => {
    rmSync(evictDir, { recursive: true, force: true })
  })

  it('does not evict when below limit', () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(evictDir, `session-${i}.jsonl`), '{}\n')
    }
    const evicted = evictOldSessionsInternal(evictDir, 'session-keep', 50)
    assert.equal(evicted.length, 0)
  })

  it('evicts oldest sessions beyond limit keeping current', () => {
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(evictDir, `ev-${i}.jsonl`), '{}\n')
    }
    writeFileSync(join(evictDir, 'ev-keep.jsonl'), '{}\n')
    const evicted = evictOldSessionsInternal(evictDir, 'ev-keep', 10)
    // 13 total - 10 limit = 3 should be evicted
    assert.ok(evicted.length >= 3)
    assert.ok(!evicted.includes('ev-keep'))
    // Keep file should still exist
    assert.ok(existsSync(join(evictDir, 'ev-keep.jsonl')))
  })

  it('handles empty directory', () => {
    const emptyDir = join(evictDir, 'empty')
    mkdirSync(emptyDir, { recursive: true })
    const evicted = evictOldSessionsInternal(emptyDir, 'none', 10)
    assert.equal(evicted.length, 0)
  })
})

describe('checksum integration', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-checksum-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('appends and loads messages with checksum', async () => {
    const persist = new SessionPersist('test-checksum')
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }
    
    await persist.appendWithChecksum(message)
    const loaded = persist.loadWithChecksum()
    
    assert.equal(loaded.length, 1)
    assert.deepEqual(loaded[0], message)
  })

  it('loads legacy format without checksum', async () => {
    const persist = new SessionPersist('test-legacy')
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }
    
    // 手动写入旧格式
    const { appendFileSync } = await import('node:fs')
    appendFileSync(persist.getFilePath(), JSON.stringify(message) + '\n')
    
    const loaded = persist.loadWithChecksum()
    
    assert.equal(loaded.length, 1)
    assert.deepEqual(loaded[0], message)
  })

  it('skips invalid checksum lines', async () => {
    const persist = new SessionPersist('test-invalid-checksum')
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }
    
    // 写入有效消息
    await persist.appendWithChecksum(message)
    
    // 写入无效校验和
    const { appendFileSync } = await import('node:fs')
    appendFileSync(persist.getFilePath(), '{"invalid": true}|0000000000000000\n')
    
    const loaded = persist.loadWithChecksum()
    
    assert.equal(loaded.length, 1)
    assert.deepEqual(loaded[0], message)
  })
})

describe('fuzzy checkpoint', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-checkpoint-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('detects incomplete compact', async () => {
    const persist = new SessionPersist('test-checkpoint')
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }
    
    // 写入消息和 compact_start
    await persist.append(message)
    persist.appendCompactStart(1, 1)
    
    assert.equal(persist.detectIncompleteCompact(), true)
  })

  it('detects complete compact', async () => {
    const persist = new SessionPersist('test-checkpoint-complete')
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }
    
    // 写入消息、compact_start 和 compact_end
    await persist.append(message)
    persist.appendCompactStart(1, 1)
    persist.appendCompactEnd(1, 0)
    
    assert.equal(persist.detectIncompleteCompact(), false)
  })

  it('loadRecoverableMessages detects incomplete compact', async () => {
    const persist = new SessionPersist('test-recoverable-checkpoint')
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }
    
    // 写入消息和 compact_start
    await persist.append(message)
    persist.appendCompactStart(1, 1)
    
    const result = persist.loadRecoverableMessages()
    
    assert.equal(result.hadIncompleteCompact, true)
  })
})
