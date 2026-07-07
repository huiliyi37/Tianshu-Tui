import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ASK_USER_QUESTION_TOOL } from '../ask-user-question.js'
import type { ToolCallParams } from '../types.js'

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: '/tmp' }
}

describe('ask_user_question endTurn signal', () => {
  it('returns endTurn: true in ToolResult', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(
      makeParams({ question: 'Pick one' }),
    )
    assert.equal(result.endTurn, true)
  })

  it('returns endTurn: true even with options', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(
      makeParams({ question: 'Which?', options: ['a', 'b', 'c'] }),
    )
    assert.equal(result.endTurn, true)
    assert.ok(result.uiContent)
    assert.ok(result.uiContent!.includes('1. a'))
  })
})
