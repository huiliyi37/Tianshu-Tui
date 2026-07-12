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

test('renderChoicePanel: selected choice has cursor ▶', () => {
  const lines = renderChoicePanel(makeData({ selectedIndex: 1 }), 60, 20, theme)
  const plain = lines.map(stripAnsi)
  // selectedIndex=1 → second choice should have ▶ cursor
  const bLine = plain.find(l => l.includes('压缩上下文'))
  assert.ok(bLine && bLine.includes('▶'), 'selected choice has ▶ cursor')
  // First choice should NOT have cursor
  const aLine = plain.find(l => l.includes('降级模型'))
  assert.ok(aLine && !aLine.includes('▶'), 'non-selected choice has no cursor')
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
