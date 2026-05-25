import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupOrphanedTmpFiles } from '../fs-atomic.js'
import { cleanupOldArtifactSessions } from '../artifact/store.js'

function backdate(filePath: string, ms: number): void {
  const past = Date.now() - ms
  utimesSync(filePath, new Date(past), new Date(past))
}

describe('cleanupOrphanedTmpFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tmp-cleanup-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deletes orphaned .tmp files matching the fs-atomic pattern', () => {
    const oldTmp = join(tmpDir, 'data.json.a1b2c3d4.tmp')
    writeFileSync(oldTmp, '{}')
    backdate(oldTmp, 7_200_000) // 2 hours ago

    const cleaned = cleanupOrphanedTmpFiles([tmpDir])
    assert.equal(cleaned, 1)
    assert.ok(!existsSync(oldTmp))
  })

  it('does not delete recent .tmp files', () => {
    const recentTmp = join(tmpDir, 'data.json.e5f6a7b8.tmp')
    writeFileSync(recentTmp, '{}')

    const cleaned = cleanupOrphanedTmpFiles([tmpDir])
    assert.equal(cleaned, 0)
    assert.ok(existsSync(recentTmp))
  })

  it('ignores files that do not match the pattern', () => {
    const randomTmp = join(tmpDir, 'notes.tmp')
    writeFileSync(randomTmp, 'hello')
    backdate(randomTmp, 7_200_000)

    const wrongLen = join(tmpDir, 'data.json.ab12.tmp')
    writeFileSync(wrongLen, '{}')
    backdate(wrongLen, 7_200_000)

    const cleaned = cleanupOrphanedTmpFiles([tmpDir])
    assert.equal(cleaned, 0)
    assert.ok(existsSync(randomTmp))
    assert.ok(existsSync(wrongLen))
  })

  it('handles non-existent directories gracefully', () => {
    const cleaned = cleanupOrphanedTmpFiles(['/nonexistent/path'])
    assert.equal(cleaned, 0)
  })

  it('cleans files from multiple directories', () => {
    const dir1 = join(tmpDir, 'a')
    const dir2 = join(tmpDir, 'b')
    mkdirSync(dir1)
    mkdirSync(dir2)

    const f1 = join(dir1, 'x.11111111.tmp')
    const f2 = join(dir2, 'y.22222222.tmp')
    writeFileSync(f1, '')
    writeFileSync(f2, '')
    backdate(f1, 7_200_000)
    backdate(f2, 7_200_000)

    const cleaned = cleanupOrphanedTmpFiles([dir1, dir2])
    assert.equal(cleaned, 2)
    assert.ok(!existsSync(f1))
    assert.ok(!existsSync(f2))
  })
})

describe('cleanupOldArtifactSessions', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'artifact-cleanup-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deletes old session directories beyond TTL', () => {
    const oldSession = join(tmpDir, 'old-session')
    mkdirSync(oldSession)
    writeFileSync(join(oldSession, '_index.jsonl'), '')
    backdate(oldSession, 8 * 24 * 3_600_000) // 8 days ago

    const cleaned = cleanupOldArtifactSessions(tmpDir, 'active-session')
    assert.equal(cleaned, 1)
    assert.ok(!existsSync(oldSession))
  })

  it('never deletes the active session directory', () => {
    const activeDir = join(tmpDir, 'active-session')
    mkdirSync(activeDir)
    writeFileSync(join(activeDir, '_index.jsonl'), '')
    backdate(activeDir, 8 * 24 * 3_600_000) // 8 days ago, but still active

    const cleaned = cleanupOldArtifactSessions(tmpDir, 'active-session')
    assert.equal(cleaned, 0)
    assert.ok(existsSync(activeDir))
  })

  it('keeps recent session directories', () => {
    const recentSession = join(tmpDir, 'recent-session')
    mkdirSync(recentSession)
    writeFileSync(join(recentSession, '_index.jsonl'), '')

    const cleaned = cleanupOldArtifactSessions(tmpDir, 'active-session')
    assert.equal(cleaned, 0)
    assert.ok(existsSync(recentSession))
  })

  it('handles non-existent base directory gracefully', () => {
    const cleaned = cleanupOldArtifactSessions('/nonexistent/path', 'active')
    assert.equal(cleaned, 0)
  })

  it('skips non-directory entries', () => {
    writeFileSync(join(tmpDir, 'not-a-dir'), '')

    const cleaned = cleanupOldArtifactSessions(tmpDir, 'active-session')
    assert.equal(cleaned, 0)
  })

  it('evicts oldest sessions when count exceeds limit', () => {
    // Create 52 sessions (beyond MAX=50), all recent so TTL doesn't apply
    const sessionNames: string[] = []
    for (let i = 0; i < 52; i++) {
      const name = `session-${String(i).padStart(3, '0')}`
      const dir = join(tmpDir, name)
      mkdirSync(dir)
      writeFileSync(join(dir, '_index.jsonl'), '')
      // Stagger mtimes: session-000 is oldest
      const offset = (52 - i) * 60_000 // 1 minute apart
      backdate(dir, offset)
      sessionNames.push(name)
    }

    const cleaned = cleanupOldArtifactSessions(tmpDir, 'active-session')
    // Should have cleaned 2 (52 - 50)
    assert.equal(cleaned, 2)
    // Oldest two should be gone
    assert.ok(!existsSync(join(tmpDir, 'session-000')))
    assert.ok(!existsSync(join(tmpDir, 'session-001')))
    // session-002 and above should survive
    assert.ok(existsSync(join(tmpDir, 'session-002')))
  })
})
