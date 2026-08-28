import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderChoicePanel, type ChoicePanelData } from '../format/overlay.js'
import { getTheme } from '../theme.js'

function stripAnsi(s: string): string { return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') }


const theme = getTheme()

function makeData(overrides: Partial<ChoicePanelData> = {}): ChoicePanelData {
  return {
    title: '选择策略',
    choices: [
      { id: 'a', label: '降级模型', description: '切换到更快的模型继续执行' },
      { id: 'b', label: '压缩上下文', description: '保留关键信息,裁剪历史' },
      { id: 'c', label: '继续等待', description: '保持当前模型,等待响应' },
    ],
    selectedIndex: 0,
    ...overrides,
  }
}

// ── Basic rendering ────────────────────────────────────────────

test('renderChoicePanel: renders title and all choices', () => {
  const lines = renderChoicePanel(makeData(), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('选择策略'), 'title present')
  assert.ok(plain.includes('降级模型'), 'choice A label present')
  assert.ok(plain.includes('压缩上下文'), 'choice B label present')
  assert.ok(plain.includes('继续等待'), 'choice C label present')
})

test('renderChoicePanel: descriptions shown under labels', () => {
  const lines = renderChoicePanel(makeData(), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('切换到更快的模型继续执行'), 'choice A description present')
})

test('renderChoicePanel: selected choice has cursor >', () => {
  const lines = renderChoicePanel(makeData({ selectedIndex: 1 }), 60, 20, theme)
  const plain = lines.map(stripAnsi)
  // selectedIndex=1 → second choice should have > cursor
  const bLine = plain.find(l => l.includes('压缩上下文'))
  assert.ok(bLine && bLine.includes('>'), 'selected choice has > cursor')
  // First choice should NOT have cursor
  const aLine = plain.find(l => l.includes('降级模型'))
  assert.ok(aLine && !aLine.includes('>'), 'non-selected choice has no cursor')
})

test('renderChoicePanel: recommended choice has ★ marker', () => {
  const data = makeData({
    choices: [
      { id: 'a', label: '选项A' },
      { id: 'b', label: '选项B', description: 'desc', recommended: true },
      { id: 'c', label: '选项C' },
    ],
  })
  const lines = renderChoicePanel(data, 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('★'), 'recommended marker present')
  const bLine = plain.split('\n').find(l => l.includes('选项B'))
  assert.ok(bLine && bLine.includes('★'), '★ on recommended choice')
})

test('renderChoicePanel: current choice has "← current" marker', () => {
  const data = makeData({
    choices: [
      { id: 'a', label: '选项A' },
      { id: 'b', label: '选项B', current: true },
      { id: 'c', label: '选项C' },
    ],
  })
  const lines = renderChoicePanel(data, 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('← current'), 'current marker present')
  const bLine = plain.split('\n').find(l => l.includes('选项B'))
  assert.ok(bLine && bLine.includes('← current'), '← current on current choice')
  const aLine = plain.split('\n').find(l => l.includes('选项A'))
  assert.ok(aLine && !aLine.includes('← current'), 'non-current choice has no marker')
})

test('renderChoicePanel: choice without description renders label only', () => {
  const data: ChoicePanelData = {
    title: '确认操作',
    choices: [{ id: 'yes', label: '确认' }, { id: 'no', label: '取消' }],
    selectedIndex: 0,
  }
  const lines = renderChoicePanel(data, 40, 12, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('确认'))
  assert.ok(plain.includes('取消'))
})

test('renderChoicePanel: footer shows navigation hints', () => {
  const lines = renderChoicePanel(makeData(), 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('↑↓'), 'up/down hint present')
  assert.ok(plain.includes('Enter'), 'enter hint present')
  assert.ok(plain.includes('Esc'), 'esc hint present')
})

test('renderChoicePanel: empty choices does not crash', () => {
  const lines = renderChoicePanel({ title: '空', choices: [], selectedIndex: 0 }, 40, 10, theme)
  assert.ok(lines.length > 0)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('空'), 'title still renders')
})

test('renderChoicePanel: long description wraps within inner width', () => {
  const data: ChoicePanelData = {
    title: 'T',
    choices: [
      {
        id: 'a',
        label: '选项',
        description: '这是一个非常长的描述，它应该会被自动换行处理，确保不会超出终端宽度边界。'.repeat(2),
      },
    ],
    selectedIndex: 0,
  }
  const lines = renderChoicePanel(data, 50, 20, theme)
  // No line should exceed the width (accounting for border characters)
  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 50, `line too long: ${stripAnsi(line).length}`)
  }
})

test('renderChoicePanel: title without question mark renders cleanly', () => {
  const data: ChoicePanelData = {
    title: '星位推荐',
    choices: [{ id: 'tianshu', label: '天枢 · 定向者', description: '结构化 · 验证优先' }],
    selectedIndex: 0,
  }
  const lines = renderChoicePanel(data, 50, 12, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('星位推荐'))
  assert.ok(plain.includes('天枢'))
})

// ── Input sub-mode ─────────────────────────────────────────────

test('renderChoicePanel: input sub-mode renders input box and keeps choices visible', () => {
  const data = makeData({
    inputSubMode: {
      active: true,
      label: '自定义回答',
      placeholder: '输入你的回答',
      value: '',
    },
  })
  const lines = renderChoicePanel(data, 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('降级模型'), 'choices still visible')
  assert.ok(plain.includes('自定义回答'), 'input label present')
  assert.ok(plain.includes('输入你的回答'), 'placeholder present')
  assert.ok(plain.includes('↵'), 'submit hint present')
})

test('renderChoicePanel: input sub-mode renders current value', () => {
  const data = makeData({
    inputSubMode: {
      active: true,
      label: '驳回反馈',
      placeholder: '可留空',
      value: '请补充测试用例',
    },
  })
  const lines = renderChoicePanel(data, 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('请补充测试用例'), 'input value present')
  assert.ok(!plain.includes('可留空'), 'placeholder hidden when value present')
})

// ── Scroll window (short terminals) ────────────────────────────

test('renderChoicePanel: selected choice stays visible in a short panel', () => {
  const choices = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `选项${i}` }))
  const data: ChoicePanelData = { title: '长列表', choices, selectedIndex: 9 }
  const lines = renderChoicePanel(data, 50, 12, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('选项9'), 'selected choice visible')
  assert.ok(!plain.includes('选项0'), 'top choices scrolled out')
  assert.ok(plain.includes('↑ 以上还有'), 'top indicator')
  // 居中窗口已够到列表尾部——底部无截断，且光标下方邻项可见。
  assert.ok(plain.includes('选项10'), 'option below the cursor visible (centered window)')
  assert.ok(lines.length <= 12, `frame fits height (${lines.length})`)
})

// ── Input sub-mode cursor（硬件 caret，对标 connect overlay）────────────

test('renderChoicePanel: input sub-mode places hardware caret at cursorPos', () => {
  const data = makeData({
    inputSubMode: {
      active: true,
      label: '自定义回答',
      placeholder: '输入你的回答',
      value: 'abcdef',
      cursorPos: 3,
    },
  })
  renderChoicePanel(data, 60, 20, theme)
  // 值前缀宽 3（ASCII）→ col = 值起始列 5（边框1 + " > "3）+ 3 = 8，与 connect 同公式
  assert.deepEqual(data.caret, { row: data.caret?.row ?? 0, col: 8 })
  assert.ok((data.caret?.row ?? 0) > 0, 'caret row set (1-based within overlay body)')
})

test('renderChoicePanel: caret col uses display width（CJK 双宽）', () => {
  const data = makeData({
    inputSubMode: { active: true, label: 'l', placeholder: 'p', value: '天枢abc', cursorPos: 2 },
  })
  renderChoicePanel(data, 60, 20, theme)
  // 「天枢」UTF-16 偏移 0..2，显示宽 4 → col = 5 + 4 = 9
  assert.equal(data.caret?.col, 9)
})

test('renderChoicePanel: empty value caret parks before placeholder, no trailing ▏ glyph', () => {
  const data = makeData({
    inputSubMode: { active: true, label: '自定义回答', placeholder: '输入你的回答', value: '', cursorPos: 0 },
  })
  const lines = renderChoicePanel(data, 60, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.equal(data.caret?.col, 5, 'caret at value start (border 1 + " > " 3)')
  assert.ok(!plain.includes('▏'), 'no in-line cursor glyph — hardware caret only')
})

test('renderChoicePanel: long value windows head away to keep caret visible', () => {
  const value = 'x'.repeat(80)
  const data = makeData({
    inputSubMode: { active: true, label: 'l', placeholder: 'p', value, cursorPos: value.length },
  })
  const lines = renderChoicePanel(data, 60, 20, theme)
  const inputLine = stripAnsi(lines.find(l => l.includes('x')) ?? '')
  // 宽 60：可视 max=54，光标在末尾 → 行首被丢弃，但 caret col 必须落在框内
  renderChoicePanel(data, 60, 20, theme)
  assert.ok((data.caret?.col ?? 0) <= 60, 'caret col within panel width')
  assert.ok(inputLine.length > 0, 'input line renders')
})

test('renderChoicePanel: caret reset to null without input sub-mode', () => {
  const data = makeData()
  renderChoicePanel(data, 60, 20, theme)
  assert.equal(data.caret, null)
})
