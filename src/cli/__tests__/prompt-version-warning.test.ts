import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const testDir = mkdtempSync(join(tmpdir(), 'prompt-warning-test-'))
process.env.RIVET_HOME = testDir

// Import after setting RIVET_HOME so marker file lands in the temp dir.
const { maybePrintStaticPromptCacheWarning } = await import('../prompt-version-warning.js')
const { buildSystemPrompt } = await import('../../prompt/static.js')

let stderr = ''
const originalStderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string | Uint8Array, ...args: any[]) => {
  stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  return originalStderrWrite(chunk, ...(args as []))
}) as typeof process.stderr.write

beforeEach(() => { stderr = '' })

after(() => {
  process.stderr.write = originalStderrWrite
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('maybePrintStaticPromptCacheWarning', () => {
  beforeEach(() => {
    try { rmSync(join(testDir, '.static-prompt-hash')) } catch { /* ignore */ }
  })

  it('prints warning when no stored hash exists', () => {
    maybePrintStaticPromptCacheWarning()
    assert.ok(stderr.includes('系统提示词已变更'), 'should warn on first run')
    assert.ok(stderr.includes('前缀缓存将在下一轮失效'), 'should mention cache invalidation')
    assert.ok(stderr.includes('建议：升级后请新建会话'), 'should advise new session')
    assert.ok(stderr.includes('Static prompt changed; start a new session'), 'should include short english line')
  })

  it('prints warning when stored hash differs', () => {
    writeFileSync(join(testDir, '.static-prompt-hash'), ' stale-hash ', 'utf8')
    maybePrintStaticPromptCacheWarning()
    assert.ok(stderr.includes('系统提示词已变更'), 'should warn when hash differs')
  })

  it('does not print warning when stored hash matches current prompt', () => {
    const currentPrompt = buildSystemPrompt({ tools: [] })
    const currentHash = createHash('sha256').update(currentPrompt, 'utf8').digest('hex')
    writeFileSync(join(testDir, '.static-prompt-hash'), currentHash, 'utf8')
    maybePrintStaticPromptCacheWarning()
    assert.ok(!stderr.includes('Static prompt changed since last run'), 'should not warn when hash matches')
  })

  it('writes current prompt hash to marker file after warning', () => {
    maybePrintStaticPromptCacheWarning()
    const stored = readFileSync(join(testDir, '.static-prompt-hash'), 'utf8').trim()
    const currentPrompt = buildSystemPrompt({ tools: [] })
    const expectedHash = createHash('sha256').update(currentPrompt, 'utf8').digest('hex')
    assert.equal(stored, expectedHash)
  })
})
