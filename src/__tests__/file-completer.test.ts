import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractAtToken, getCompletions, applyCompletion } from '../tui/file-completer.js'

describe('extractAtToken', () => {
  it('extracts @-prefixed token at cursor', () => {
    assert.equal(extractAtToken('fix @src/ma', 11), 'src/ma')
    assert.equal(extractAtToken('hello @', 7), '')
    assert.equal(extractAtToken('no at here', 5), null)
  })

  it('returns null when no @ before cursor', () => {
    assert.equal(extractAtToken('plain text', 5), null)
  })
})

describe('getCompletions', () => {
  it('returns matching files from cwd', () => {
    const results = getCompletions('src/tui/app', process.cwd(), 5)
    assert.ok(results.length > 0)
    assert.ok(results[0]!.includes('src/tui/app'))
  })

  it('limits results', () => {
    const results = getCompletions('src/', process.cwd(), 3)
    assert.ok(results.length <= 3)
  })

  it('returns empty array for nonexistent path', () => {
    const results = getCompletions('nonexistent-xyz-123/', process.cwd(), 5)
    assert.equal(results.length, 0)
  })
})

describe('applyCompletion', () => {
  it('replaces @token with completion and adds trailing space', () => {
    const result = applyCompletion('fix @src/ma', 11, 'src/main.tsx')
    assert.equal(result.text, 'fix @src/main.tsx ')
    assert.equal(result.cursor, 18)
  })
})
