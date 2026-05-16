import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { forkSession } from '../agent/session-fork.js'

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
