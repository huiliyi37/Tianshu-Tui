import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractIntents, type Intent } from '../intent-extractor.js'

describe('extractIntents', () => {
  it('extracts file paths from text', () => {
    const intents = extractIntents('I need to read src/auth/middleware.ts to understand the pattern')
    assert.ok(intents.some(i => i.type === 'file' && i.value === 'src/auth/middleware.ts'))
  })

  it('extracts multiple file paths', () => {
    const intents = extractIntents('Look at src/api/client.ts and src/agent/loop.ts')
    const files = intents.filter(i => i.type === 'file')
    assert.equal(files.length, 2)
  })

  it('extracts test file references', () => {
    const intents = extractIntents('run the tests in auth.test.ts')
    assert.ok(intents.some(i => i.type === 'test' && i.value.includes('auth.test.ts')))
  })

  it('extracts npm/bash commands', () => {
    const intents = extractIntents('I should run npm test to verify')
    assert.ok(intents.some(i => i.type === 'command' && i.value === 'npm test'))
  })

  it('extracts typecheck intent', () => {
    const intents = extractIntents('let me check with tsc --noEmit')
    assert.ok(intents.some(i => i.type === 'command' && i.value.includes('tsc')))
  })

  it('ignores paths inside code blocks', () => {
    const intents = extractIntents('```\nconst path = "src/fake.ts"\n```')
    assert.equal(intents.filter(i => i.type === 'file').length, 0)
  })

  it('returns empty array for text with no intents', () => {
    const intents = extractIntents('This is just a plain explanation with no paths.')
    assert.equal(intents.length, 0)
  })

  it('deduplicates repeated file paths', () => {
    const intents = extractIntents('Read src/a.ts, then edit src/a.ts')
    const files = intents.filter(i => i.type === 'file')
    assert.equal(files.length, 1)
  })
})
