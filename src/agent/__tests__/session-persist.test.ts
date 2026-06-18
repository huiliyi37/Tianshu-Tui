import { describe, it, beforeEach, afterEach, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_SESSION_MESSAGE_JSON_CHARS, SessionPersist, evictOldSessionsInternal, serializeSessionMessage } from '../session-persist.js'
import type { OaiMessage } from '../../api/oai-types.js'

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
    const persist = new SessionPersist('test-session-001', tempDir)
    const store = persist.createClaimStore()
    assert.ok(store)
    assert.equal(typeof store.propose, 'function')
    assert.equal(typeof store.listActiveClaims, 'function')
  })

  it('buildMemoryBlock returns string for fresh session', () => {
    const persist = new SessionPersist('test-session-002', tempDir)
    const block = persist.buildMemoryBlock()
    assert.equal(typeof block, 'string')
  })

  it('getSessionMemoryState returns undefined for fresh session', () => {
    const persist = new SessionPersist('test-session-003', tempDir)
    const state = persist.getSessionMemoryState()
    assert.equal(state, undefined)
  })

  it('injectDurableClaims does not throw on fresh store', () => {
    const persist = new SessionPersist('test-session-004', tempDir)
    const store = persist.createClaimStore()
    assert.doesNotThrow(() => persist.injectDurableClaims(store))
  })

  it('getBackupDir returns a path containing the session id', () => {
    const persist = new SessionPersist('test-session-005', tempDir)
    const dir = persist.getBackupDir()
    assert.equal(typeof dir, 'string')
    assert.ok(dir.includes('test-session-005'))
  })

  it('caps oversized session message JSON lines', () => {
    const serialized = serializeSessionMessage({ role: 'user', content: 'x'.repeat(MAX_SESSION_MESSAGE_JSON_CHARS * 2) } as any)

    assert.ok(serialized.length <= MAX_SESSION_MESSAGE_JSON_CHARS + 512)
    assert.match(serialized, /session-message-truncated/)
  })
})

describe('SessionPersist — metadata (P1)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-meta-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('initMetadata creates metadata file with defaults', () => {
    const persist = new SessionPersist('meta-init-001', tempDir)
    persist.initMetadata({ model: 'deepseek-v4' })

    const meta = persist.loadMetadata()
    assert.ok(meta)
    assert.equal(meta!.model, 'deepseek-v4')
    assert.equal(meta!.status, 'active')
    assert.equal(meta!.turnCount, 0)
    assert.equal(meta!.toolCallCount, 0)
    assert.ok(meta!.createdAt > 0)
    assert.ok(meta!.tokenUsage)
    assert.equal(meta!.tokenUsage!.prompt, 0)
    assert.equal(meta!.tokenUsage!.completion, 0)
    assert.equal(meta!.tokenUsage!.total, 0)
  })

  it('initMetadata is idempotent — does not overwrite existing', () => {
    const persist = new SessionPersist('meta-idempotent', tempDir)
    persist.initMetadata({ model: 'model-v1' })
    persist.updateMetadata({ turnCount: 5 })
    // Second init should be a no-op
    persist.initMetadata({ model: 'model-v2' })

    const meta = persist.loadMetadata()
    assert.equal(meta!.model, 'model-v1')
    assert.equal(meta!.turnCount, 5)
  })

  it('updateMetadata merges partial fields', () => {
    const persist = new SessionPersist('meta-patch', tempDir)
    persist.initMetadata({ model: 'deepseek-v4' })
    persist.updateMetadata({ turnCount: 3, toolCallCount: 10 })
    persist.updateMetadata({ turnCount: 4, title: 'Fix the bug' })

    const meta = persist.loadMetadata()
    assert.equal(meta!.model, 'deepseek-v4')
    assert.equal(meta!.turnCount, 4)
    assert.equal(meta!.toolCallCount, 10)
    assert.equal(meta!.title, 'Fix the bug')
  })

  it('updateMetadata merges tokenUsage without losing existing fields', () => {
    const persist = new SessionPersist('meta-tokens', tempDir)
    persist.initMetadata()
    persist.updateMetadata({ tokenUsage: { prompt: 100, completion: 50, total: 150 } })
    persist.updateMetadata({ tokenUsage: { prompt: 200, completion: 60, total: 260 } })

    const meta = persist.loadMetadata()
    assert.equal(meta!.tokenUsage!.prompt, 200)
    assert.equal(meta!.tokenUsage!.completion, 60)
    assert.equal(meta!.tokenUsage!.total, 260)
  })

  it('updateMetadata preserves createdAt', () => {
    const persist = new SessionPersist('meta-created', tempDir)
    persist.initMetadata()
    const originalCreatedAt = persist.loadMetadata()!.createdAt

    // Wait a tiny bit and update
    persist.updateMetadata({ turnCount: 1 })
    const meta = persist.loadMetadata()
    assert.equal(meta!.createdAt, originalCreatedAt)
    assert.ok(meta!.updatedAt >= originalCreatedAt)
  })

  it('updateMetadata advances updatedAt past createdAt (regression: spread order froze it)', () => {
    // Stub Date.now so the test is deterministic and the advance is observable
    // without sleeping. Regression guard: a prior bug spread ...existing AFTER
    // updatedAt, re-overwriting it with the stale value so it never advanced.
    let clock = 1_000
    const now = mock.method(Date, 'now', () => clock)
    try {
      const persist = new SessionPersist('meta-updatedat', tempDir)
      persist.initMetadata()
      const created = persist.loadMetadata()!
      assert.equal(created.createdAt, 1_000)
      assert.equal(created.updatedAt, 1_000)

      clock = 5_000
      persist.updateMetadata({ turnCount: 1 })
      const after = persist.loadMetadata()!
      assert.equal(after.createdAt, 1_000, 'createdAt must be preserved')
      assert.equal(after.updatedAt, 5_000, 'updatedAt must advance to current time')
      assert.ok(after.updatedAt > after.createdAt, 'updatedAt must move past createdAt on update')
    } finally {
      now.mock.restore()
    }
  })

  it('loadMetadata returns undefined when no metadata file exists', () => {
    const persist = new SessionPersist('meta-noexist', tempDir)
    assert.equal(persist.loadMetadata(), undefined)
  })

  it('listSessionsWithMetadata returns sorted results', async () => {
    // Create sessions with .jsonl files (required by listSessions) + metadata
    const p1 = new SessionPersist('meta-list-1', tempDir)
    await p1.appendOaiWithChecksum({ role: 'user', content: 'hello' })
    p1.initMetadata()
    p1.updateMetadata({ title: 'older session' })

    const p2 = new SessionPersist('meta-list-2', tempDir)
    await p2.appendOaiWithChecksum({ role: 'user', content: 'hello2' })
    p2.initMetadata()
    p2.updateMetadata({ title: 'newer session', turnCount: 1 })

    const sessions = SessionPersist.listSessionsWithMetadata(tempDir)
    const ourSessions = sessions.filter(s => s.id.startsWith('meta-list-'))
    assert.equal(ourSessions.length, 2)
    // Most recent first
    assert.ok(ourSessions[0]!.updatedAt >= ourSessions[1]!.updatedAt)
  })
})

describe('SessionPersist — resolveSessionId / formatSessionList / listMainSessions', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-resolve-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
    SessionPersist.invalidateListCache()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
    SessionPersist.invalidateListCache()
  })

  async function seed(id: string, title: string): Promise<void> {
    const p = new SessionPersist(id, tempDir)
    await p.appendOaiWithChecksum({ role: 'user', content: title })
    p.initMetadata({ model: 'deepseek-v4' })
    p.updateMetadata({ title })
    SessionPersist.invalidateListCache()
  }

  it('exact id match wins', async () => {
    await seed('aaaa1111-0000', 'one')
    await seed('aaaa2222-0000', 'two')
    assert.deepEqual(SessionPersist.resolveSessionId(tempDir, 'aaaa1111-0000'), { id: 'aaaa1111-0000' })
  })

  it('unique prefix resolves to the full id', async () => {
    await seed('abcd1234-0000', 'one')
    await seed('wxyz9999-0000', 'two')
    assert.deepEqual(SessionPersist.resolveSessionId(tempDir, 'abcd'), { id: 'abcd1234-0000' })
  })

  it('ambiguous prefix returns candidate list', async () => {
    await seed('dup11111-0000', 'one')
    await seed('dup22222-0000', 'two')
    const r = SessionPersist.resolveSessionId(tempDir, 'dup')
    assert.ok(r && 'ambiguous' in r)
    assert.equal((r as { ambiguous: string[] }).ambiguous.length, 2)
  })

  it('no match returns null (incl. empty ref)', async () => {
    await seed('aaaa1111-0000', 'one')
    assert.equal(SessionPersist.resolveSessionId(tempDir, 'zzzz'), null)
    assert.equal(SessionPersist.resolveSessionId(tempDir, ''), null)
    assert.equal(SessionPersist.resolveSessionId(tempDir, '   '), null)
  })

  it('excludes worker sub-sessions from listing and resolution', async () => {
    await seed('main1111-0000', 'main')
    await seed('worker-abcdef01', 'worker child')
    const ids = SessionPersist.listMainSessions(tempDir).map(s => s.id)
    assert.ok(ids.includes('main1111-0000'))
    assert.ok(!ids.some(id => id.startsWith('worker-')))
    assert.equal(SessionPersist.resolveSessionId(tempDir, 'worker-'), null)
  })

  it('formatSessionList renders rows and marks the current session', async () => {
    await seed('cur00000-0000', 'current one')
    const out = SessionPersist.formatSessionList(tempDir, 'cur00000-0000')
    assert.match(out, /cur00000/)
    assert.match(out, /当前/)
    assert.match(out, /current one/)
  })

  it('formatSessionList handles an empty session dir', () => {
    const out = SessionPersist.formatSessionList(tempDir)
    assert.match(out, /没有历史会话/)
  })
})

describe('SessionPersist — persisted messages', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-msg-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('persists truncated oversized messages as loadable JSON', async () => {
    const persist = new SessionPersist('test-session-large-message', tempDir)
    await persist.appendWithChecksum({ role: 'user', content: 'x'.repeat(MAX_SESSION_MESSAGE_JSON_CHARS * 2) } as any)

    const messages = persist.load()
    assert.equal(messages.length, 1)
    assert.match(String(messages[0]!.content), /session-message-truncated/)
  })

  it('appends and loads OpenAI-native messages with checksum', async () => {
    const persist = new SessionPersist('test-session-oai', tempDir)
    const messages: OaiMessage[] = [
      { role: 'user', content: 'Read a file' },
      {
        role: 'assistant',
        content: 'Reading.',
        reasoning_content: 'Need file context.',
        tool_calls: [
          {
            id: 'call_read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read', content: 'contents' },
    ]

    for (const message of messages) {
      await persist.appendOaiWithChecksum(message)
    }

    assert.deepEqual(persist.loadOai(), messages)
  })

  it('migrates legacy session messages to OAI on loadOai', async () => {
    const persist = new SessionPersist('test-session-oai-legacy', tempDir)
    await persist.appendWithChecksum({ role: 'user', content: 'Start' } as any)
    await persist.appendWithChecksum({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Need context.' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'README.md' } },
      ],
    } as any)
    await persist.appendWithChecksum({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'contents' }],
    } as any)

    assert.deepEqual(persist.loadOai(), [
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: 'Reading.',
        reasoning_content: 'Need context.',
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tu_1', content: 'contents' },
    ])
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

  it('removes same-name session directory when evicting (getBackupDir leak)', () => {
    // Simulate what getBackupDir() creates: <session-id>/backups/
    // Without rmSync on the directory, these accumulate forever.
    const sessDir = join(evictDir, 'worker-leak')
    mkdirSync(join(sessDir, 'backups'), { recursive: true })
    writeFileSync(join(sessDir, 'backups', 'dummy.txt'), 'test')
    // Need the .jsonl for evict to notice the session
    writeFileSync(join(evictDir, 'worker-leak.jsonl'), '{}\n')

    // Fill up to trigger eviction (limit=1, keep=another)
    writeFileSync(join(evictDir, 'worker-keep.jsonl'), '{}\n')

    const evicted = evictOldSessionsInternal(evictDir, 'worker-keep', 1)
    assert.ok(evicted.includes('worker-leak'))
    // Directory must be gone — this is the bug we're fixing
    assert.ok(!existsSync(sessDir), 'session directory should be removed on evict')
    // Keep session's files/dirs should survive
    assert.ok(existsSync(join(evictDir, 'worker-keep.jsonl')))
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
    const persist = new SessionPersist('test-checksum', tempDir)
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
    const persist = new SessionPersist('test-legacy', tempDir)
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
    const persist = new SessionPersist('test-invalid-checksum', tempDir)
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

  it('appendModelSwitch writes a checksummed event that is skipped on replay', async () => {
    const persist = new SessionPersist('test-model-switch', tempDir)
    // 真实消息 + 中间夹一条切换事件
    await persist.appendOaiWithChecksum({ role: 'user', content: 'before switch' })
    persist.appendModelSwitch({ from: 'claude-opus-4-8', to: 'deepseek-v4-pro', provider: 'deepseek' })
    await persist.appendOaiWithChecksum({ role: 'assistant', content: 'after switch' })

    // model_switch 行不进消息历史（与 compact_start/end 同等待遇），不破坏 replay
    const loaded = persist.loadOai()
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0]!.content, 'before switch')
    assert.equal(loaded[1]!.content, 'after switch')

    // 但事件确实落盘且通过 checksum（裸读文件能看到 model_switch 行）
    const { readFileSync } = await import('node:fs')
    const raw = readFileSync(persist.getFilePath(), 'utf-8')
    assert.match(raw, /"type":"model_switch"/)
    assert.match(raw, /"to":"deepseek-v4-pro"/)
    assert.match(raw, /"from":"claude-opus-4-8"/)
  })
})
