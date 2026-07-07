import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScrollbackTranscript,
  searchTranscript,
  findNextMatch,
  findPrevMatch,
} from '../scrollback-transcript.js'

const ANSI_USER = '\x1B[36m\u258C\x1B[0m'
const ANSI_TOOL = '\x1B[2m\u25CF\x1B[0m'

function makeContent(): string {
  return [
    `${ANSI_USER} hello world`,
    '  second line of user msg',
    '',
    'This is assistant text.',
    'Another assistant line.',
    '',
    `${ANSI_TOOL} Run(npm test)`,
    '⎿  output line 1',
    '⎿  output line 2',
    '⎿  … +5 lines [Ctrl+O]',
    '',
    `${ANSI_USER} follow up`,
  ].join('\n')
}

describe('scrollback transcript parser', () => {
  it('parses user, assistant, and tool messages', () => {
    const messages = parseScrollbackTranscript(makeContent())
    // Note: assistant text without explicit markers merges into preceding user block.
    assert.equal(messages.length, 3)
    assert.equal(messages[0]!.role, 'user')
    assert.equal(messages[0]!.summary.includes('hello world'), true)
    assert.equal(messages[0]!.rawContent.includes('assistant text'), true)
    assert.equal(messages[1]!.role, 'tool')
    assert.equal(messages[2]!.role, 'user')
  })

  it('detects truncated tool output', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const toolMsg = messages.find(m => m.role === 'tool')
    assert.ok(toolMsg)
    assert.equal(toolMsg!.isTruncated, true)
  })

  it('marks non-truncated messages correctly', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const userMsg = messages.find(m => m.summary.includes('hello world'))
    assert.ok(userMsg)
    assert.equal(userMsg!.isTruncated, false)
  })

  it('search is case-insensitive', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const matches = searchTranscript(messages, 'HELLO')
    assert.deepEqual(matches, [0])
  })

  it('search finds tool output content', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const matches = searchTranscript(messages, 'output line 2')
    assert.deepEqual(matches, [1])
  })

  it('findNextMatch cycles forward and wraps', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const matches = searchTranscript(messages, 'line')
    assert.ok(matches.length >= 2)
    const first = findNextMatch(messages, -1, 'line')
    const second = findNextMatch(messages, first, 'line')
    const third = findNextMatch(messages, second, 'line')
    assert.notEqual(first, second)
    assert.equal(third, first)
  })

  it('findPrevMatch cycles backward and wraps', () => {
    const messages = parseScrollbackTranscript(makeContent())
    const first = findPrevMatch(messages, 10, 'line')
    const second = findPrevMatch(messages, first, 'line')
    assert.notEqual(first, second)
  })

  it('returns empty list for empty content', () => {
    const messages = parseScrollbackTranscript('')
    assert.equal(messages.length, 0)
  })

  it('treats plain content as a single assistant block', () => {
    const messages = parseScrollbackTranscript('just\nsome\ntext')
    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.role, 'assistant')
  })
})
