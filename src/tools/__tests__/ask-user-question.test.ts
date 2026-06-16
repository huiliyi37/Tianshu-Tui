import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ASK_USER_QUESTION_TOOL } from '../ask-user-question.js'
import type { ToolCallParams } from '../types.js'

function params(input: Record<string, unknown>): ToolCallParams {
  return { input, cwd: process.cwd() } as unknown as ToolCallParams
}

describe('ASK_USER_QUESTION_TOOL', () => {
  it('returns a placeholder to the model and the question to the UI', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(params({ question: 'Which approach?' }))
    assert.equal(result.content, '[Awaiting your response…]')
    assert.equal(result.uiContent, 'Which approach?')
  })

  it('renders structured options as a numbered list in uiContent', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(params({
      question: 'Which database?',
      options: ['Postgres', 'SQLite', 'MySQL'],
    }))
    assert.equal(result.content, '[Awaiting your response…]')
    assert.ok(result.uiContent!.includes('Which database?'))
    assert.ok(result.uiContent!.includes('1. Postgres'))
    assert.ok(result.uiContent!.includes('2. SQLite'))
    assert.ok(result.uiContent!.includes('3. MySQL'))
    assert.ok(!result.uiContent!.includes('pick more than one'))
  })

  it('adds a multi-select hint when allow_multiple is true', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(params({
      question: 'Which features?',
      options: ['Auth', 'Billing'],
      allow_multiple: true,
    }))
    assert.ok(result.uiContent!.includes('pick more than one'))
  })

  it('ignores non-string and empty options', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(params({
      question: 'Pick one',
      options: ['Valid', '', '   ', 42, null],
    }))
    assert.ok(result.uiContent!.includes('1. Valid'))
    assert.ok(!result.uiContent!.includes('2.'))
  })

  it('falls back to plain question when options is empty', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(params({
      question: 'Open ended?',
      options: [],
    }))
    assert.equal(result.uiContent, 'Open ended?')
  })
})
