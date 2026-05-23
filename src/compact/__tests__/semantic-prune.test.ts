import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { semanticPruneLayer1 } from '../semantic-prune.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('semanticPruneLayer1', () => {
  function makeToolResult(toolCallId: string, content: string): OaiMessage {
    return { role: 'tool', tool_call_id: toolCallId, content }
  }
  function makeAssistant(toolCalls: { id: string; name: string; args: string }[]): OaiMessage {
    return {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } })),
    }
  }

  it('prunes junk directory entries from list_dir results', () => {
    const dirContent = [
      'src/', 'src/agent/', 'src/api/', 'src/compact/', 'src/tools/',
      'node_modules/', 'node_modules/.bin/', 'node_modules/express/', 'node_modules/typescript/',
      'node_modules/@types/', 'node_modules/lodash/', 'node_modules/chalk/',
      '__pycache__/', '__pycache__/foo.pyc', '__pycache__/bar.pyc',
      '.git/objects/', '.git/refs/', '.git/hooks/',
      'package.json', 'README.md', 'tsconfig.json',
    ].join('\n')
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      makeAssistant([{ id: 'tc1', name: 'list_dir', args: '{"path":"."}' }]),
      makeToolResult('tc1', dirContent),
    ]
    const result = semanticPruneLayer1(messages, 2)
    assert.ok(result.prunedCount > 0)
    assert.ok(result.savedChars > 0)
    const toolMsg = result.messages[3]!
    assert.ok(toolMsg.role === 'tool')
    assert.ok(toolMsg.content.includes('junk directory entries removed'))
    assert.ok(!toolMsg.content.includes('node_modules/.bin'))
  })

  it('prunes test pass lines from bash results', () => {
    const passLines = Array.from({ length: 20 }, (_, i) => `  ✓ should handle test case number ${i} correctly (${i + 10}ms)`)
    const content = `Running tests...\nTest suite: src/agent/loop.test.ts\n${passLines.join('\n')}\n  ✗ should handle error case failing\n\n20 passing, 1 failing`
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      makeAssistant([{ id: 'tc1', name: 'bash', args: '{"command":"npm test"}' }]),
      makeToolResult('tc1', content),
    ]
    const result = semanticPruneLayer1(messages, 2)
    assert.ok(result.prunedCount > 0)
    const toolMsg = result.messages[3]!
    assert.ok(toolMsg.role === 'tool')
    assert.ok(toolMsg.content.includes('passing test lines removed'))
    assert.ok(toolMsg.content.includes('error case failing'))
  })

  it('deduplicates grep results for same pattern', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      makeAssistant([{ id: 'tc1', name: 'grep', args: '{"pattern":"TODO"}' }]),
      makeToolResult('tc1', 'src/a.ts:5: // TODO fix this\nsrc/b.ts:10: // TODO refactor'),
      { role: 'user', content: 'more' },
      makeAssistant([{ id: 'tc2', name: 'grep', args: '{"pattern":"TODO"}' }]),
      makeToolResult('tc2', 'src/a.ts:5: // TODO fix this\nsrc/b.ts:10: // TODO refactor\nsrc/c.ts:1: // TODO new'),
    ]
    const result = semanticPruneLayer1(messages, 2)
    assert.ok(result.prunedCount > 0)
    const oldGrep = result.messages[3]!
    assert.ok(oldGrep.role === 'tool')
    assert.ok(oldGrep.content.includes('outdated grep'))
  })

  it('skips short tool results', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      makeAssistant([{ id: 'tc1', name: 'list_dir', args: '{"path":"."}' }]),
      makeToolResult('tc1', 'short'),
    ]
    const result = semanticPruneLayer1(messages, 2)
    assert.equal(result.prunedCount, 0)
  })

  it('respects anchor boundary', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      makeAssistant([{ id: 'tc1', name: 'list_dir', args: '{"path":"."}' }]),
      makeToolResult('tc1', 'node_modules/\nnode_modules/a/\nnode_modules/b/\n__pycache__/\n__pycache__/x\nfoo.ts'),
    ]
    // anchor=3 means all messages are in anchor zone
    const result = semanticPruneLayer1(messages, 3)
    assert.equal(result.prunedCount, 0)
  })
})
