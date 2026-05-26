import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyMemoryEntry,
  extractSessionMemories,
} from '../session-memory-extract.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('extractSessionMemories', () => {
  it('extracts file observations from tool results and recent targets', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'read context.ts' },
      { role: 'assistant', content: 'reading the file...' },
      { role: 'tool', tool_call_id: 't1', content: 'export interface Example from src/agent/context.ts' },
    ]

    const memories = extractSessionMemories(messages, {
      recentToolTargets: ['src/agent/loop.ts'],
    })

    const fileObs = memories.filter(m => m.kind === 'file_observation')
    assert.ok(fileObs.some(m => m.text.includes('src/agent/context.ts')), 'should extract file path from tool output')
    assert.ok(fileObs.some(m => m.text.includes('src/agent/loop.ts')), 'should extract relative recent tool target')
  })

  it('extracts decision patterns from assistant messages', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'should I use Map or Set?' },
      { role: 'assistant', content: 'Use Map because we need key-value lookup. The decision is based on O(1) access requirement.' },
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
    ]

    const memories = extractSessionMemories(messages, {})

    const decisions = memories.filter(m => m.kind === 'decision')
    assert.ok(decisions.some(m => m.text.includes('Map')), 'should extract decision from assistant reasoning')
  })

  it('extracts error patterns from tool results', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'run tests' },
      { role: 'assistant', content: 'running tests...' },
      { role: 'tool', tool_call_id: 't1', content: 'TypeError: Cannot read property of undefined at context.ts:42' },
    ]

    const memories = extractSessionMemories(messages, {})

    const failures = memories.filter(m => m.kind === 'failure_pattern')
    assert.ok(failures.length > 0, 'should extract failure pattern from error output')
    assert.ok(failures[0]!.text.includes('TypeError'), 'should contain error type')
  })

  it('deduplicates similar memories', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'read file' },
      { role: 'assistant', content: 'Use Map because key-value storage needs O(1) lookup.' },
      { role: 'tool', tool_call_id: 't1', content: 'export class SessionContext { ... }' },
      { role: 'user', content: 'read another' },
      { role: 'assistant', content: 'As decided earlier, Map is the right choice for O(1) lookup.' },
      { role: 'tool', tool_call_id: 't2', content: 'export class SessionContext { ... }' },
    ]

    const memories = extractSessionMemories(messages, {
      recentToolTargets: ['src/agent/context.ts', 'src/agent/loop.ts'],
    })

    const mapDecisions = memories.filter(m => m.kind === 'decision' && m.text.includes('Map'))
    assert.ok(mapDecisions.length <= 1, 'should deduplicate repeated decisions')
  })

  it('returns empty array for empty messages', () => {
    const memories = extractSessionMemories([], {})
    assert.equal(memories.length, 0, 'should return empty for no messages')
  })
})

describe('classifyMemoryEntry', () => {
  it('classifies user feedback', () => {
    const result = classifyMemoryEntry('Please always use const instead of let', 'user')
    assert.equal(result.kind, 'user_preference')
  })

  it('classifies decision from assistant', () => {
    const result = classifyMemoryEntry('We decided to use Map for performance reasons', 'assistant')
    assert.equal(result.kind, 'decision')
  })

  it('classifies error from tool result', () => {
    const result = classifyMemoryEntry('Error: ENOENT: no such file or directory', 'tool')
    assert.equal(result.kind, 'failure_pattern')
  })

  it('classifies relative file path as file observation', () => {
    const result = classifyMemoryEntry('src/agent/context.ts', 'tool')
    assert.equal(result.kind, 'file_observation')
  })
})
