import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestions, renderAskUserQuestionText } from '../ask-user-question.js'
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
    // With options, the model must see the SAME numbering the user sees — a
    // bare "1" reply is otherwise ambiguous to the model.
    assert.ok(result.content.startsWith('[Awaiting your response…]'))
    assert.ok(result.content.includes('1. Postgres'))
    assert.ok(result.content.includes('2. SQLite'))
    assert.ok(result.content.includes('bare number'))
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

  it('errors when neither question nor questions is provided', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(params({}))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('question'))
  })

  it('renders the multi-question form with per-question numbering', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(params({
      questions: [
        { prompt: 'Enter plan mode?', options: ['Yes', 'No'] },
        { prompt: 'Which scope?', options: ['Frontend', 'Backend'], allow_multiple: true },
      ],
    }))
    assert.ok(result.content.startsWith('[Awaiting your response…]'))
    assert.ok(result.content.includes('1. Yes'))
    assert.equal(result.endTurn, true)
    assert.ok(result.uiContent!.includes('1. Enter plan mode?'))
    assert.ok(result.uiContent!.includes('2. Which scope?'))
    assert.ok(result.uiContent!.includes('pick more than one'))
  })
})

describe('parseAskUserQuestions', () => {
  it('normalizes the legacy single-question form to one item', () => {
    const items = parseAskUserQuestions({ question: 'Which DB?', options: ['A', 'B'], allow_multiple: true })
    assert.equal(items.length, 1)
    assert.equal(items[0]!.id, 'q1')
    assert.equal(items[0]!.prompt, 'Which DB?')
    assert.deepEqual(items[0]!.options, ['A', 'B'])
    assert.equal(items[0]!.allowMultiple, true)
  })

  it('parses the multi-question form and auto-assigns ids', () => {
    const items = parseAskUserQuestions({
      questions: [
        { prompt: 'First?', options: ['X'] },
        { id: 'custom', prompt: 'Second?' },
      ],
    })
    assert.equal(items.length, 2)
    assert.equal(items[0]!.id, 'q1')
    assert.equal(items[1]!.id, 'custom')
    assert.deepEqual(items[1]!.options, [])
  })

  it('questions[] takes precedence over the single-question fields', () => {
    const items = parseAskUserQuestions({
      question: 'legacy',
      questions: [{ prompt: 'structured' }],
    })
    assert.equal(items.length, 1)
    assert.equal(items[0]!.prompt, 'structured')
  })

  it('skips malformed entries and returns [] when nothing is valid', () => {
    assert.deepEqual(parseAskUserQuestions({ questions: [null, { options: ['a'] }, 42] }), [])
    assert.deepEqual(parseAskUserQuestions({}), [])
    assert.deepEqual(parseAskUserQuestions({ question: '   ' }), [])
  })

  it('renderAskUserQuestionText matches the single-question legacy rendering', () => {
    const items = parseAskUserQuestions({ question: 'Pick', options: ['A', 'B'] })
    const text = renderAskUserQuestionText(items)
    assert.ok(text.startsWith('Pick'))
    assert.ok(text.includes('  1. A'))
    assert.ok(text.includes('  2. B'))
  })
})
