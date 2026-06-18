import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionPersist } from '../session-persist.js'

describe('handoff persist', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-handoff-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('writeHandoff writes handoff markdown file', () => {
    const persist = new SessionPersist('current-session', tempDir)
    persist.writeHandoff('hello handoff')

    const handoffPath = join(tempDir, 'current-session.handoff.md')
    assert.ok(existsSync(handoffPath), 'handoff file should exist')
    assert.equal(readFileSync(handoffPath, 'utf-8'), 'hello handoff')
  })

  it('loadPrevHandoff routes by exact domain match', () => {
    // Current session carries a domain tag.
    writeFileSync(join(tempDir, 'current-session.jsonl'), '{"type":"noop"}\n')
    writeFileSync(join(tempDir, 'current-session.meta.json'), JSON.stringify({
      sessionId: 'current-session',
      createdAt: 1000,
      updatedAt: 1000,
      compactEvents: [],
      domain: 'tianliang',
    }))

    // Same-domain candidate: should be chosen even if it is older than the cross-domain session.
    writeFileSync(join(tempDir, 'prev-same-domain.jsonl'), '{"type":"noop"}\n')
    writeFileSync(join(tempDir, 'prev-same-domain.meta.json'), JSON.stringify({
      sessionId: 'prev-same-domain',
      createdAt: 500,
      updatedAt: 500,
      compactEvents: [],
      domain: 'tianliang',
    }))
    writeFileSync(join(tempDir, 'prev-same-domain.handoff.md'), 'same domain handoff')

    // Cross-domain candidate: newer, but must be skipped when current session has a domain.
    writeFileSync(join(tempDir, 'prev-diff-domain.jsonl'), '{"type":"noop"}\n')
    writeFileSync(join(tempDir, 'prev-diff-domain.meta.json'), JSON.stringify({
      sessionId: 'prev-diff-domain',
      createdAt: 600,
      updatedAt: 2000,
      compactEvents: [],
      domain: 'other',
    }))
    writeFileSync(join(tempDir, 'prev-diff-domain.handoff.md'), 'other domain handoff')

    const result = SessionPersist.loadPrevHandoff(tempDir, 'current-session', 'tianliang')
    assert.equal(result, 'same domain handoff')
  })

  it('loadPrevHandoff falls back to most recent when current session has no domain', () => {
    writeFileSync(join(tempDir, 'current-session.jsonl'), '{"type":"noop"}\n')
    writeFileSync(join(tempDir, 'current-session.meta.json'), JSON.stringify({
      sessionId: 'current-session',
      createdAt: 1000,
      updatedAt: 1000,
      compactEvents: [],
    }))

    writeFileSync(join(tempDir, 'prev-newer.jsonl'), '{"type":"noop"}\n')
    writeFileSync(join(tempDir, 'prev-newer.meta.json'), JSON.stringify({
      sessionId: 'prev-newer',
      createdAt: 100,
      updatedAt: 800,
      compactEvents: [],
    }))
    writeFileSync(join(tempDir, 'prev-newer.handoff.md'), 'newer handoff')

    writeFileSync(join(tempDir, 'prev-older.jsonl'), '{"type":"noop"}\n')
    writeFileSync(join(tempDir, 'prev-older.meta.json'), JSON.stringify({
      sessionId: 'prev-older',
      createdAt: 50,
      updatedAt: 400,
      compactEvents: [],
    }))
    writeFileSync(join(tempDir, 'prev-older.handoff.md'), 'older handoff')

    const result = SessionPersist.loadPrevHandoff(tempDir, 'current-session')
    assert.equal(result, 'newer handoff')
  })
})
