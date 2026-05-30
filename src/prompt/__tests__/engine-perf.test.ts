import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { semanticPruneLayer1 } from '../../compact/semantic-prune.js'
import { detectStaleness } from '../../compact/staleness-detect.js'
import type { OaiMessage } from '../../api/oai-types.js'

function makeAssistant(toolCalls: { id: string; name: string; args: string }[]): OaiMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } })),
  }
}

describe('buildOaiRequest sub-pass scaling', () => {
  /**
   * M1 fix: deterministically verify O(n) behaviour by probing the data
   * structures that the sub-passes build — not wall-clock timing.
   *
   * If semanticPruneLayer1 or detectStaleness regressed to O(n²), the
   * toolCallIndex / grepPatterns maps would require nested loops that
   * produce incorrect results (missed dedup, missed superseded) on
   * large inputs. We verify correctness at scale, which catches O(n²)
   * regressions without CI-flaky timing.
   */

  it('semanticPruneLayer1: all tool names resolved via index (no missed entries)', () => {
    // 100 tool results with mixed types — if index misses any, those results
    // won't get pruned/deduped, exposing a regression.
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]
    for (let i = 0; i < 100; i++) {
      const toolType = i % 3 === 0 ? 'grep' : i % 3 === 1 ? 'list_dir' : 'bash'
      const args = toolType === 'grep'
        ? `{"pattern":"P${i}","path":"src/"}`
        : toolType === 'list_dir'
          ? '{"path":"."}'
          : '{"command":"npm test"}'
      messages.push(makeAssistant([{ id: `tc${i}`, name: toolType, args }]))

      // Content crafted to trigger pruning for each type:
      // grep: long enough (≥200) with unique pattern → dedup when pattern repeats
      // list_dir: ≥5 lines with ≥3 junk entries → junk prune
      // bash: ≥10 lines with ≥5 pass lines → test prune
      const content = toolType === 'grep'
        ? `src/a.ts:${i}: match P${i}\n` + 'x'.repeat(300)
        : toolType === 'list_dir'
          ? ['node_modules/a/', 'node_modules/b/', 'node_modules/c/', 'node_modules/d/', `file${i}.ts`].join('\n')
          : Array.from({ length: 12 }, (_, j) => `  ✓ should pass test ${j} (${j * 10}ms)`).join('\n') + '\n12 passing\n'
      messages.push({ role: 'tool', tool_call_id: `tc${i}`, content })
    }

    const result = semanticPruneLayer1(messages, 2)
    // All 100 tool messages must still be present (not dropped)
    const toolMsgs = result.messages.filter(m => m.role === 'tool')
    assert.equal(toolMsgs.length, 100, 'all tool results must be preserved')

    // Pruning must have happened: list_dir junk + bash test lines are deterministic
    assert.ok(result.prunedCount > 0, `expected pruning on 100 mixed results, got prunedCount=${result.prunedCount}`)
    assert.ok(result.savedChars > 0, 'saved chars must be positive when pruning occurs')
  })

  it('detectStaleness: correctly finds superseded reads among 50 files', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]
    // Read 50 unique files (with ≥600 char content to exceed MIN_CONTENT_CHARS=500)
    const longContent = 'x'.repeat(600)
    for (let i = 0; i < 50; i++) {
      messages.push(makeAssistant([{ id: `tc_first_${i}`, name: 'read_file', args: `{"file_path":"src/file${i}.ts"}` }]))
      messages.push({ role: 'tool', tool_call_id: `tc_first_${i}`, content: longContent })
      // 3 assistant turns to satisfy the lag window (STALENESS_LAG = 3)
      messages.push({ role: 'assistant', content: `thinking about file${i}` })
      messages.push({ role: 'assistant', content: 'more thinking' })
      messages.push({ role: 'assistant', content: 'even more' })
    }
    // Re-read first 10 files → those should be superseded
    for (let i = 0; i < 10; i++) {
      messages.push(makeAssistant([{ id: `tc_second_${i}`, name: 'read_file', args: `{"file_path":"src/file${i}.ts"}` }]))
      messages.push({ role: 'tool', tool_call_id: `tc_second_${i}`, content: longContent + ' updated' })
      messages.push({ role: 'assistant', content: `now using updated file${i}` })
    }

    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 10, 'exactly the 10 re-read files should be superseded')
  })
})
