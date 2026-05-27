import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { distillSession, persistDream, type DreamInput } from '../dream.js'

function knowledgePath(cwd: string): string {
  return join(cwd, '.rivet', 'knowledge', 'project-memory.md')
}

function baseInput(overrides: Partial<DreamInput> = {}): DreamInput {
  return {
    filesModified: [],
    filesRead: [],
    verifications: [],
    decisions: [],
    trajectoryEntries: [],
    sessionId: 'test-session',
    ...overrides,
  }
}

function withTempDir(name: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), name))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('distillSession', () => {
  it('returns null when no curated memory criterion is present', () => {
    const input = baseInput({
      filesModified: ['src/foo.ts'],
      filesRead: ['src/bar.ts'],
      verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 10, failed: 0, skipped: 0, durationMs: 1234 }],
      trajectoryEntries: [
        { tool: 'edit_file', target: 'src/foo.ts', status: 'success' },
        { tool: 'run_tests', target: 'npm test', status: 'success' },
      ],
    })

    assert.strictEqual(distillSession(input), null)
  })

  it('generates curated memory for an architectural invariant', () => {
    const result = distillSession(baseInput({
      decisions: ['Architectural invariant: SessionContext is mutable shared state; workers must use independent sessions.'],
      sessionId: 'test-session-abcdef',
    }))

    assert.ok(result)
    assert.ok(result.includes('architectural_invariant'))
    assert.ok(result.includes('SessionContext is mutable shared state'))
    assert.ok(result.includes('Curated project memory'))
  })

  it('accepts convergence insight, selection rule, conceptual reframe, and reusable pattern criteria', () => {
    const result = distillSession(baseInput({
      decisions: [
        'Convergence insight: subagent coordination is not more concurrency but typed work order/result packets plus primary authority.',
        'Selection rule: small tasks should stay inline; delegate only when there are three independent exploration fronts.',
        'Conceptual reframe: memory is not storage but selection pressure.',
        'Reusable design pattern: trigger + diagnosis + fix is the durable shape for repair knowledge.',
      ],
    }))

    assert.ok(result)
    assert.ok(result.includes('convergence_insight'))
    assert.ok(result.includes('selection_rule'))
    assert.ok(result.includes('conceptual_reframe'))
    assert.ok(result.includes('reusable_design_pattern'))
  })

  it('does not treat navigator preference as a write criterion', () => {
    const result = distillSession(baseInput({
      decisions: ['Navigator preference: preserve my personal taste in project memory.'],
    }))

    assert.strictEqual(result, null)
  })

  it('omits low-level telemetry from curated entries', () => {
    const result = distillSession(baseInput({
      filesModified: ['src/foo.ts'],
      filesRead: ['src/bar.ts'],
      verifications: [{ command: 'npm test', status: 'failed', scope: 'full' as const, exitCode: 1, passed: 8, failed: 2, skipped: 0, durationMs: 5678 }],
      trajectoryEntries: [{ tool: 'edit_file', target: 'src/foo.ts', status: 'success' }],
      decisions: ['Selection rule: ordinary failed tests stay in verification output, not long-term project memory.'],
    }))

    assert.ok(result)
    assert.ok(!result.includes('**Modified**'))
    assert.ok(!result.includes('**Read**'))
    assert.ok(!result.includes('**Tests**'))
    assert.ok(!result.includes('**Tools used**'))
    assert.ok(!result.includes('src/foo.ts'))
    assert.ok(!result.includes('8 passed'))
  })
})

describe('persistDream', () => {
  it('writes curated memory when a criterion is present', () => {
    withTempDir('dream-curated-', dir => {
      persistDream(dir, baseInput({
        decisions: ['Conceptual reframe: project memory is not a changelog; it is a judgment cache.'],
        sessionId: 'session-curated',
      }))

      const path = knowledgePath(dir)
      assert.ok(existsSync(path), 'should create .rivet/knowledge/project-memory.md')
      const content = readFileSync(path, 'utf-8')
      assert.ok(content.includes('judgment cache'))
      assert.ok(content.includes('conceptual_reframe'))
    })
  })

  it('does not create file for file modifications alone', () => {
    withTempDir('dream-noise-', dir => {
      persistDream(dir, baseInput({
        filesModified: ['src/a.ts'],
        verifications: [{ command: 'npm test', status: 'passed', scope: 'full' as const, exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 999 }],
      }))

      assert.ok(!existsSync(knowledgePath(dir)))
    })
  })

  it('prepends new curated entries to existing project memory', () => {
    withTempDir('dream-prepend-', dir => {
      persistDream(dir, baseInput({
        decisions: ['Selection rule: first memory should remain below later memory after prepend.'],
        sessionId: 'session-first',
      }))
      persistDream(dir, baseInput({
        decisions: ['Architectural invariant: second memory should be prepended before older entries.'],
        sessionId: 'session-second',
      }))

      const content = readFileSync(knowledgePath(dir), 'utf-8')
      const firstIdx = content.indexOf('first memory')
      const secondIdx = content.indexOf('second memory')
      assert.ok(secondIdx < firstIdx, `second memory should come before first, got second at ${secondIdx} first at ${firstIdx}`)
    })
  })

  it('deduplicates same curated memory in the same day', () => {
    withTempDir('dream-dedup-', dir => {
      const input = baseInput({
        decisions: ['Reusable design pattern: typed work order/result packet keeps worker output useful and bounded.'],
        sessionId: 'session-dup1',
      })

      persistDream(dir, input)
      persistDream(dir, { ...input, sessionId: 'session-dup2' })
      persistDream(dir, { ...input, sessionId: 'session-dup3' })

      const content = readFileSync(knowledgePath(dir), 'utf-8')
      const entryCount = (content.match(/^### /gm) || []).length
      assert.equal(entryCount, 1)
    })
  })

  it('writes to knowledge/ which volatile.ts reads for prompt injection', () => {
    withTempDir('dream-target-', dir => {
      persistDream(dir, baseInput({
        decisions: ['Convergence insight: Dream should store future judgment rules rather than session telemetry.'],
        sessionId: 'target-test',
      }))

      const kPath = knowledgePath(dir)
      assert.ok(existsSync(kPath), 'dream must write curated entries to .rivet/knowledge/project-memory.md')
      const content = readFileSync(kPath, 'utf-8')
      assert.ok(content.includes('future judgment rules'))
      const sessionsDir = join(dir, '.rivet', 'sessions')
      assert.ok(!existsSync(sessionsDir), 'should not create .rivet/sessions/')
    })
  })
})
