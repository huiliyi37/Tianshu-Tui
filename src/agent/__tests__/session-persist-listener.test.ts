import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionContext } from '../context.js'
import { SessionPersist } from '../session-persist.js'
import { attachSessionPersistListener } from '../session-persist-listener.js'

let tempDir: string

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'persist-listener-'))
})

after(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

/** Poll until the async write chain lands the metadata patch. */
async function waitForPrompt(persist: SessionPersist, expected: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const meta = persist.loadMetadata()
    if (meta?.tokenUsage?.prompt === expected) return
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('attachSessionPersistListener — meta tokenUsage accounting', () => {
  it('prompt equals cache-inclusive input_tokens, not input+read+create (2x regression)', async () => {
    // Field bug (session 6bfc4465): meta prompt was exactly 2x the real 5.67M
    // because the patch added cache_read + cache_creation on top of DeepSeek's
    // already cache-inclusive input_tokens.
    const session = new SessionContext()
    const persist = new SessionPersist('meta-prompt-2x', tempDir)
    persist.initMetadata({ model: 'deepseek-v4-pro' })
    attachSessionPersistListener({ session, persist })

    // DeepSeek semantics: input = hit + miss.
    session.addUsage({
      input_tokens: 1000,
      output_tokens: 40,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200,
    })
    // Trigger the listener via a message append (the hot path that patches meta).
    session.addUserMessage('hello')

    await waitForPrompt(persist, 1000)
    const meta = persist.loadMetadata()
    assert.ok(meta?.tokenUsage)
    assert.equal(meta.tokenUsage.prompt, 1000)
    assert.equal(meta.tokenUsage.completion, 40)
    assert.equal(meta.tokenUsage.total, 1040)
  })
})
