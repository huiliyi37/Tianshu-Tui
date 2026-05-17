import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { distillSession, persistDream, type DreamInput } from '../dream.js'

describe('distillSession', () => {
  it('returns null when no files modified', () => {
    const input: DreamInput = {
      filesModified: [],
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    assert.strictEqual(distillSession(input), null)
  })

  it('generates knowledge entry when files modified', () => {
    const input: DreamInput = {
      filesModified: ['src/foo.ts', 'src/bar.ts'],
      filesRead: ['src/baz.ts'],
      verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 10, failed: 0, skipped: 0, durationMs: 1234 }],
      decisions: ['Use composition over inheritance'],
      trajectoryEntries: [
        { tool: 'edit_file', target: 'src/foo.ts', status: 'success' },
        { tool: 'run_tests', target: 'npm test', status: 'success' },
      ],
      sessionId: 'test-session',
    }
    const result = distillSession(input)
    assert.ok(result)
    assert.ok(result.includes('src/foo.ts'))
    assert.ok(result.includes('src/bar.ts'))
    assert.ok(result.includes('10 pass'))
    assert.ok(result.includes('composition over inheritance'))
  })

  it('marks unverified sessions', () => {
    const input: DreamInput = {
      filesModified: ['src/foo.ts'],
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    const result = distillSession(input)
    assert.ok(result)
    assert.ok(result.includes('unverified'))
  })

  it('includes failure info when tests failed', () => {
    const input: DreamInput = {
      filesModified: ['src/foo.ts'],
      filesRead: [],
      verifications: [{ command: 'npm test', status: 'failed', scope: 'full' as const, exitCode: 1, passed: 8, failed: 2, skipped: 0, durationMs: 5678 }],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    const result = distillSession(input)
    assert.ok(result)
    assert.ok(result.includes('failed'))
    assert.ok(result.includes('8 passed'))
  })

  it('truncates long file lists', () => {
    const input: DreamInput = {
      filesModified: Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`),
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    const result = distillSession(input)
    assert.ok(result)
    assert.ok(result.includes('+'))
  })
})

describe('persistDream', () => {
  let tmpDir: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dream-test-'))
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes knowledge file when files modified', () => {
    const input: DreamInput = {
      filesModified: ['src/a.ts'],
      filesRead: [],
      verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 999 }],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    persistDream(tmpDir, input)
    const path = join(tmpDir, '.rivet', 'knowledge', 'project-memory.md')
    assert.ok(existsSync(path))
    const content = readFileSync(path, 'utf-8')
    assert.ok(content.includes('src/a.ts'))
    assert.ok(content.includes('3 passed'))
  })

  it('does not create file when no files modified', () => {
    // Ensure clean state
    const knowledgeDir = join(tmpDir, '.rivet', 'knowledge')
    const path = join(knowledgeDir, 'project-memory.md')
    try { rmSync(knowledgeDir, { recursive: true, force: true }) } catch { /* ok */ }

    const input: DreamInput = {
      filesModified: [],
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'test-session',
    }
    persistDream(tmpDir, input)
    assert.ok(!existsSync(path))
  })

  it('prepends new entries to existing file', () => {
    const input1: DreamInput = {
      filesModified: ['src/a.ts'],
      filesRead: [],
      verifications: [],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'session-first',
    }
    persistDream(tmpDir, input1)

    const input2: DreamInput = {
      filesModified: ['src/b.ts'],
      filesRead: [],
      verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 2345 }],
      decisions: [],
      trajectoryEntries: [],
      sessionId: 'session-second',
    }
    persistDream(tmpDir, input2)

    const path = join(tmpDir, '.rivet', 'knowledge', 'project-memory.md')
    const content = readFileSync(path, 'utf-8')
    const idxA = content.indexOf('src/a.ts')
    const idxB = content.indexOf('src/b.ts')
    // Most recent entry (b) should come first
    assert.ok(idxB < idxA, `b.ts should come before a.ts, got b at ${idxB} a at ${idxA}`)
  })

  it('truncates at entry boundary, not mid-line', () => {
    // Use a fresh tmpDir for this test
    const truncDir = mkdtempSync(join(tmpdir(), 'dream-trunc-'))
    try {
      for (let i = 0; i < 15; i++) {
        persistDream(truncDir, {
          filesModified: Array.from({ length: 8 }, (_, j) => `src/module${i}/file${j}.ts`),
          filesRead: [],
          verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 10, failed: 0, skipped: 0, durationMs: 100 }],
          decisions: [`Decision for session ${i}`],
          trajectoryEntries: [{ tool: 'edit_file', target: `src/module${i}/file0.ts`, status: 'success' as const }],
          sessionId: `session-${String(i).padStart(4, '0')}`,
        })
      }
      const path = join(truncDir, '.rivet', 'knowledge', 'project-memory.md')
      const content = readFileSync(path, 'utf-8')
      // File should not exceed MAX_FILE_SIZE (8000)
      assert.ok(content.length <= 8000, `content length ${content.length} exceeds 8000`)
      // Every ### header should be complete
      const lines = content.split('\n')
      for (const line of lines) {
        if (line.startsWith('### ')) {
          assert.match(line, /^### \d{4}-\d{2}-\d{2}/)
        }
      }
    } finally {
      rmSync(truncDir, { recursive: true, force: true })
    }
  })

  it('deduplicates entries with same files in same day', () => {
    const dedupDir = mkdtempSync(join(tmpdir(), 'dream-dedup-'))
    try {
      const baseInput: DreamInput = {
        filesModified: ['src/same-file.ts'],
        filesRead: [],
        verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 100 }],
        decisions: [],
        trajectoryEntries: [],
        sessionId: 'session-dup1',
      }
      persistDream(dedupDir, baseInput)
      persistDream(dedupDir, { ...baseInput, sessionId: 'session-dup2' })
      persistDream(dedupDir, { ...baseInput, sessionId: 'session-dup3' })

      const path = join(dedupDir, '.rivet', 'knowledge', 'project-memory.md')
      const content = readFileSync(path, 'utf-8')
      const entryCount = (content.match(/^### /gm) || []).length
      assert.ok(entryCount <= 2, `expected <=2 entries but got ${entryCount}`)
    } finally {
      rmSync(dedupDir, { recursive: true, force: true })
    }
  })
})
