import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { forkSession, listBranches, countMessageLines } from '../agent/session-fork.js'

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-fork-'))
}

describe('forkSession', () => {
  it('creates a new JSONL file with copied messages', () => {
    const dir = makeDir()
    const original = join(dir, 'orig.jsonl')
    const lines = [
      JSON.stringify({ role: 'user', content: 'hello' }),
      JSON.stringify({ role: 'assistant', content: 'hi' }),
    ]
    writeFileSync(original, lines.join('\n') + '\n')

    const result = forkSession({ sourceJsonlPath: original, targetDir: dir })

    assert.ok(result.newSessionId.length > 0)
    assert.equal(existsSync(result.newJsonlPath), true)
    const forkedContent = readFileSync(result.newJsonlPath, 'utf-8')
    assert.equal(forkedContent.trim().split('\n').length, 2)
  })

  it('generates a unique session ID different from source', () => {
    const dir = makeDir()
    const original = join(dir, 'orig.jsonl')
    writeFileSync(original, JSON.stringify({ role: 'user', content: 'x' }) + '\n')

    const r1 = forkSession({ sourceJsonlPath: original, targetDir: dir })
    const r2 = forkSession({ sourceJsonlPath: original, targetDir: dir })
    assert.notEqual(r1.newSessionId, r2.newSessionId)
  })

  it('forks up to a specific message index', () => {
    const dir = makeDir()
    const original = join(dir, 'orig.jsonl')
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` })
    )
    writeFileSync(original, lines.join('\n') + '\n')

    const result = forkSession({ sourceJsonlPath: original, targetDir: dir, upToLine: 5 })
    const forked = readFileSync(result.newJsonlPath, 'utf-8').trim().split('\n')
    assert.equal(forked.length, 5)
  })
})

// ── fork with metadata (parentSessionId / branchName) ──────────────

describe('forkSession with metadata', () => {
  it('writes parentSessionId into the new session meta.json', () => {
    const dir = makeDir()
    const sourceId = 'source-aaaa-bbbb'
    const sourceJsonl = join(dir, `${sourceId}.jsonl`)
    writeFileSync(sourceJsonl, JSON.stringify({ role: 'user', content: 'hello' }) + '\n')

    const result = forkSession({
      sourceJsonlPath: sourceJsonl,
      targetDir: dir,
      parentSessionId: sourceId,
    })

    const metaPath = join(dir, `${result.newSessionId}.meta.json`)
    assert.ok(existsSync(metaPath), 'meta.json should be created')
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    assert.equal(meta.parentSessionId, sourceId)
  })

  it('writes branchName when provided', () => {
    const dir = makeDir()
    const sourceJsonl = join(dir, 'parent.jsonl')
    writeFileSync(sourceJsonl, JSON.stringify({ role: 'user', content: 'x' }) + '\n')

    const result = forkSession({
      sourceJsonlPath: sourceJsonl,
      targetDir: dir,
      parentSessionId: 'parent',
      branchName: 'experiment-A',
    })

    const metaPath = join(dir, `${result.newSessionId}.meta.json`)
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    assert.equal(meta.branchName, 'experiment-A')
  })

  it('does NOT write meta.json when parentSessionId is omitted (backward compat)', () => {
    const dir = makeDir()
    const original = join(dir, 'orig.jsonl')
    writeFileSync(original, JSON.stringify({ role: 'user', content: 'x' }) + '\n')

    const result = forkSession({ sourceJsonlPath: original, targetDir: dir })
    const metaPath = join(dir, `${result.newSessionId}.meta.json`)
    assert.ok(!existsSync(metaPath), 'meta.json should NOT be created without parentSessionId')
  })
})

// ── listBranches ───────────────────────────────────────────────────

describe('listBranches', () => {
  it('finds child sessions by parentSessionId', () => {
    const dir = makeDir()
    const parentId = 'parent-1111-2222'

    // Create source jsonl
    const sourceJsonl = join(dir, `${parentId}.jsonl`)
    writeFileSync(sourceJsonl, JSON.stringify({ role: 'user', content: 'parent' }) + '\n')

    // Fork two children
    forkSession({ sourceJsonlPath: sourceJsonl, targetDir: dir, parentSessionId: parentId, branchName: 'child-A' })
    forkSession({ sourceJsonlPath: sourceJsonl, targetDir: dir, parentSessionId: parentId, branchName: 'child-B' })

    const branches = listBranches(dir, parentId)
    assert.equal(branches.length, 2)
    const names = branches.map(b => b.branchName).sort()
    assert.deepEqual(names, ['child-A', 'child-B'])
  })

  it('returns empty array when no children exist', () => {
    const dir = makeDir()
    const branches = listBranches(dir, 'nonexistent-parent')
    assert.deepEqual(branches, [])
  })

  it('only returns direct children, not grandchildren', () => {
    const dir = makeDir()
    const parentId = 'parent-root'
    const sourceJsonl = join(dir, `${parentId}.jsonl`)
    writeFileSync(sourceJsonl, JSON.stringify({ role: 'user', content: 'p' }) + '\n')

    const child = forkSession({ sourceJsonlPath: sourceJsonl, targetDir: dir, parentSessionId: parentId, branchName: 'child' })
    const childJsonl = join(dir, `${child.newSessionId}.jsonl`)
    forkSession({ sourceJsonlPath: childJsonl, targetDir: dir, parentSessionId: child.newSessionId, branchName: 'grandchild' })

    const branches = listBranches(dir, parentId)
    assert.equal(branches.length, 1, 'should only find direct child, not grandchild')
    assert.equal(branches[0]!.branchName, 'child')
  })
})

// ── countMessageLines ──────────────────────────────────────────────

describe('countMessageLines', () => {
  it('counts non-empty lines in a JSONL file', () => {
    const dir = makeDir()
    const f = join(dir, 'test.jsonl')
    const lines = [
      JSON.stringify({ type: 'compact_start' }),
      JSON.stringify({ role: 'user', content: 'hello' }),
      JSON.stringify({ role: 'assistant', content: 'hi' }),
    ]
    writeFileSync(f, lines.join('\n') + '\n')

    assert.equal(countMessageLines(f), 3)
  })

  it('handles empty files', () => {
    const dir = makeDir()
    const f = join(dir, 'empty.jsonl')
    writeFileSync(f, '')
    assert.equal(countMessageLines(f), 0)
  })
})
