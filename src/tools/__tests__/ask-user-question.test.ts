import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestions, renderAskUserQuestionText } from '../ask-user-question.js'
import type { ToolCallParams, AskUserQuestionInfo } from '../types.js'

function params(input: Record<string, unknown>): ToolCallParams {
  return { input, cwd: process.cwd() } as unknown as ToolCallParams
}

describe('ASK_USER_QUESTION_TOOL', () => {
  it('returns a placeholder to the model and the question to the UI', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(params({ question: 'Which approach?' }))
    assert.equal(result.content, '[等待你的回复…]')
    assert.equal(result.uiContent, 'Which approach?')
  })

  it('renders structured options as a numbered list in uiContent', async () => {
    const result = await ASK_USER_QUESTION_TOOL.execute(params({
      question: 'Which database?',
      options: ['Postgres', 'SQLite', 'MySQL'],
    }))
    // With options, the model must see the SAME numbering the user sees — a
    // bare "1" reply is otherwise ambiguous to the model.
    assert.ok(result.content.startsWith('[等待你的回复…]'))
    assert.ok(result.content.includes('1. Postgres'))
    assert.ok(result.content.includes('2. SQLite'))
    assert.ok(result.content.includes('裸数字'))
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
    assert.ok(result.content.startsWith('[等待你的回复…]'))
    assert.ok(result.content.includes('1. Yes'))
    assert.equal(result.endTurn, true)
    assert.ok(result.uiContent!.includes('1. Enter plan mode?'))
    assert.ok(result.uiContent!.includes('2. Which scope?'))
    assert.ok(result.uiContent!.includes('pick more than one'))
  })

  it('calls onAskUserQuestion callback for single-select options', async () => {
    let called: AskUserQuestionInfo | null = null
    await ASK_USER_QUESTION_TOOL.execute({
      input: { question: 'Which provider?', options: ['OpenAI', 'Anthropic'] },
      cwd: process.cwd(),
      toolUseId: 'test',
      onAskUserQuestion: (info: AskUserQuestionInfo) => { called = info },
    } as unknown as ToolCallParams)
    assert.ok(called)
    assert.equal((called as AskUserQuestionInfo).questions.length, 1)
    assert.equal((called as AskUserQuestionInfo).questions[0]!.prompt, 'Which provider?')
    assert.deepEqual((called as AskUserQuestionInfo).questions[0]!.options, ['OpenAI', 'Anthropic'])
    assert.equal((called as AskUserQuestionInfo).questions[0]!.allowMultiple, false)
  })

  it('calls onAskUserQuestion for multi-select options (so TUI can render a picker)', async () => {
    let called = false
    await ASK_USER_QUESTION_TOOL.execute({
      input: { question: 'Which features?', options: ['Auth', 'Billing'], allow_multiple: true },
      cwd: process.cwd(),
      toolUseId: 'test',
      onAskUserQuestion: () => { called = true },
    } as unknown as ToolCallParams)
    assert.equal(called, true)
  })

  it('does not call onAskUserQuestion for open-ended questions', async () => {
    let called = false
    await ASK_USER_QUESTION_TOOL.execute({
      input: { question: 'Open ended?' },
      cwd: process.cwd(),
      toolUseId: 'test',
      onAskUserQuestion: () => { called = true },
    } as unknown as ToolCallParams)
    assert.equal(called, false)
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

  // ── LLM API schema 兼容：以下三种格式都会被原 schema 拒收——
  // 工具 spec 写的是 string[] + allow_multiple，但 Claude / 部分 SDK 会
  // 按 Anthropic 原生 schema 输出对象数组 / choices 字段 / multiSelect。
  // 这些不能静默吞掉，否则面板被 openAskUserQuestionPanel 的 options 空过滤
  // 整个踢出，用户看到的只有 LLM 输出流里的题面（「只剩问题没选项」）。

  it('Anthropic 对象数组 options: [{label, description}] 兼容为字符串数组', () => {
    const items = parseAskUserQuestions({
      questions: [{
        prompt: '选一个',
        options: [
          { label: 'A', description: 'aaa' },
          { label: 'B', description: 'bbb' },
          { label: 'C', description: 'ccc' },
        ],
      }],
    })
    assert.equal(items.length, 1)
    assert.deepEqual(items[0]!.options, ['A', 'B', 'C'])
  })

  it('对象数组里只取 label，忽略 description/preview 等其他字段', () => {
    const items = parseAskUserQuestions({
      questions: [{
        prompt: '选',
        options: [
          { label: '  苹果  ', description: 'apple' },
          { label: '香蕉', preview: 'yellow' },
        ],
      }],
    })
    // label 前后空白应清掉（与 string[] 路径一致）
    assert.deepEqual(items[0]!.options, ['苹果', '香蕉'])
  })

  it('对象数组里如果整条没 label，跳过该条不抛错', () => {
    const items = parseAskUserQuestions({
      questions: [{
        prompt: '选',
        options: [
          { description: 'no label' },
          { label: 'B' },
          null,
          'plain-string',
        ],
      }],
    })
    // null 跳过，{description only} 跳过（没 label），'plain-string' 算字符串保留
    assert.deepEqual(items[0]!.options, ['B', 'plain-string'])
  })

  it('choices 别名等价于 options', () => {
    const items = parseAskUserQuestions({
      questions: [{ prompt: '选', choices: ['X', 'Y'] }],
    })
    assert.deepEqual(items[0]!.options, ['X', 'Y'])
  })

  it('multiSelect (camelCase) 等价于 allow_multiple (snake_case)', () => {
    const items = parseAskUserQuestions({
      questions: [{ prompt: '多选', options: ['A', 'B'], multiSelect: true }],
    })
    assert.equal(items[0]!.allowMultiple, true)
  })

  it('混合 schema 字段：对象数组 + multiSelect 同时存在', () => {
    const items = parseAskUserQuestions({
      questions: [{
        prompt: '多选',
        options: [
          { label: 'A' },
          { label: 'B' },
          { label: 'C' },
        ],
        multiSelect: true,
      }],
    })
    assert.deepEqual(items[0]!.options, ['A', 'B', 'C'])
    assert.equal(items[0]!.allowMultiple, true)
  })
})
