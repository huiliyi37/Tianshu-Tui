import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'

import { renderConnect, type ConnectOverlayData } from '../format/overlay.js'
import { CURSOR } from '../format/overlay-frame.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;]*m/g, '')
}

test('renderConnect: choice step shows options with recommended marker', () => {
  const data: ConnectOverlayData = {
    view: {
      kind: 'choice',
      title: '连接模型服务商',
      subtitle: '选择一个内置服务商',
      options: [
        { id: 'deepseek', label: 'DeepSeek', description: 'https://api.deepseek.com/v1', recommended: true },
        { id: 'custom', label: '自定义服务商…' },
      ],
    },
    input: '',
    selectedIndex: 0,
  }
  const out = renderConnect(data, 60, 20, theme).map(stripAnsi).join('\n')
  assert.match(out, /连接模型服务商/)
  assert.match(out, /DeepSeek/)
  assert.match(out, /自定义服务商/)
  assert.match(out, /★/)
  assert.match(out, /Enter:确认/)
})

test('renderConnect: masked input step hides the typed key', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'input', title: '输入 DeepSeek 的 API 密钥', masked: true },
    input: 'sk-secret',
    selectedIndex: 0,
  }
  const out = renderConnect(data, 60, 20, theme).map(stripAnsi).join('\n')
  assert.match(out, /输入 DeepSeek 的 API 密钥/)
  assert.doesNotMatch(out, /sk-secret/)
  assert.match(out, /•/)
  assert.match(out, /Enter:提交/)
})

test('renderConnect: plain input step shows the typed value and step label', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'input', title: '输入服务商 API 地址', stepLabel: '步骤 1 / 4' },
    input: 'https://api.example.com',
    selectedIndex: 0,
  }
  const out = renderConnect(data, 60, 20, theme).map(stripAnsi).join('\n')
  assert.match(out, /https:\/\/api\.example\.com/)
  assert.match(out, /步骤 1 \/ 4/)
})

test('renderConnect: error line is rendered', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'input', title: '输入 API Key', masked: true },
    input: '',
    error: 'API 密钥不能为空。',
    selectedIndex: 0,
  }
  const out = renderConnect(data, 60, 20, theme).map(stripAnsi).join('\n')
  assert.match(out, /API 密钥不能为空/)
})

test('renderConnect: input caret is a hardware position — text intact, zero displacement', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'input', title: '确认服务地址' },
    input: 'abcdef',
    selectedIndex: 0,
    cursorPos: 3,
  }
  const lines = renderConnect(data, 60, 20, theme)
  const out = lines.map(stripAnsi).join('\n')
  assert.match(out, /abcdef/, '文本完整——光标不占字符格')
  assert.ok(!out.includes('▏') && !out.includes('\x1B[7m'), '无光标字形、无反色')
  // caret 落在输入行（│ 边框 1 列 + ' > ' 前缀 3 列 + abc 3 列 → 边界第 8 列）。
  const row = lines.findIndex(l => stripAnsi(l).includes('abcdef'))
  assert.ok(row >= 0)
  assert.deepEqual(data.caret, { row: row + 1, col: 8 })
})

test('renderConnect: cursorVisible=false leaves caret null (blink-off frame)', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'input', title: '确认服务地址' },
    input: 'abcdef',
    selectedIndex: 0,
    cursorPos: 3,
    cursorVisible: false,
  }
  const lines = renderConnect(data, 60, 20, theme)
  assert.equal(data.caret, null, '隐藏相位不放置硬件光标')
  assert.match(lines.map(stripAnsi).join('\n'), /abcdef/)
})

test('renderConnect: empty input shows placeholder with caret parked at the front', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'input', title: '确认服务地址', placeholder: 'https://…' },
    input: '',
    selectedIndex: 0,
    cursorPos: 0,
  }
  const lines = renderConnect(data, 60, 20, theme)
  assert.match(lines.map(stripAnsi).join('\n'), /https:\/\/…/, '占位符仅空输入时显示')
  assert.deepEqual(data.caret, { row: lines.findIndex(l => stripAnsi(l).includes('https://…')) + 1, col: 5 }, '光标停在占位符前方（句首）')
})

test('renderConnect: filter row — placeholder when empty, caret at front; query caret at text end', () => {
  const mk = (filter: string): ConnectOverlayData => ({
    view: {
      kind: 'multi-choice',
      title: '选择要添加的模型',
      options: [{ id: '0', label: 'qwen3.8-max' }],
      filter,
      optionTotal: 3,
    },
    input: '',
    selectedIndex: 0,
  })
  const empty: ConnectOverlayData = mk('')
  const lines1 = renderConnect(empty, 60, 20, theme)
  const plain1 = lines1.map(stripAnsi).join('\n')
  assert.match(plain1, /输入关键字过滤模型…/, '空查询显示占位符')
  assert.ok(!plain1.includes('▏'), '无光标字形')
  assert.match(plain1, /1\/3/, '计数紧随其后，不被光标挤开')
  assert.deepEqual(empty.caret, { row: lines1.findIndex(l => stripAnsi(l).includes('输入关键字过滤模型…')) + 1, col: 5 }, '空时 caret 停在句首')

  const q: ConnectOverlayData = mk('qwen')
  const lines2 = renderConnect(q, 60, 20, theme)
  const plain2 = lines2.map(stripAnsi).join('\n')
  assert.ok(!plain2.includes('输入关键字过滤模型…'), '有查询时占位符消失（非实体）')
  assert.match(plain2, /qwen 1\/3/)
  assert.deepEqual(q.caret, { row: lines2.findIndex(l => stripAnsi(l).includes('qwen 1/3')) + 1, col: 5 + 'qwen'.length }, 'caret 贴查询末尾')
})

test('renderConnect: form step renders arranged fields with caret on the active text field', () => {
  const data: ConnectOverlayData = {
    view: {
      kind: 'form',
      title: '未知模型补参',
      fields: [
        { id: 'contextWindow', kind: 'text', label: '上下文窗口', value: '131072' },
        { id: 'maxTokens', kind: 'text', label: '最大输出 tokens', value: '32768' },
        { id: 'template', kind: 'toggle', label: '能力模板', value: '通用文本模型（无思考输出）' },
      ],
    },
    input: '',
    selectedIndex: 0,
    formFieldIndex: 1,
    cursorPos: 2,
  }
  const lines = renderConnect(data, 80, 20, theme)
  const plain = lines.map(stripAnsi).join('\n')
  assert.match(plain, /上下文窗口：131072/)
  assert.match(plain, /最大输出 tokens：32768/)
  assert.match(plain, /能力模板：通用文本模型/)
  assert.match(plain, /↑↓:选字段/)
  const row = lines.findIndex(l => stripAnsi(l).includes('最大输出 tokens：32768'))
  assert.ok(row >= 0)
  // 与渲染器同源的宽度折算：│ 边框 + 前缀 " CURSOR 最大输出 tokens：" + 值前缀 '32'。
  const expected = stringWidth(` ${CURSOR} 最大输出 tokens：`) + 2 + 2
  assert.deepEqual(data.caret, { row: row + 1, col: expected })
})

// ── Scroll window (short terminals) ────────────────────────────

function manyOptions(n: number): Array<{ id: string; label: string; description: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `opt-${i}`,
    label: `服务商 ${i}`,
    description: `描述 ${i}`,
  }))
}

test('renderConnect: cursor far down the list stays visible in a short window', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'choice', title: '连接模型服务商', options: manyOptions(19) },
    input: '',
    selectedIndex: 15,
  }
  const lines = renderConnect(data, 60, 14, theme)
  const out = lines.map(stripAnsi).join('\n')
  assert.match(out, /服务商 15/, 'selected option visible')
  assert.doesNotMatch(out, /服务商 0[^0-9]/, 'top options scrolled out')
  assert.match(out, /↑ 以上还有/, 'top truncation indicator')
  assert.match(out, /↓ 以下还有/, 'bottom truncation indicator')
  assert.ok(lines.length <= 14, `frame fits height (${lines.length})`)
})

test('renderConnect: cursor at top renders from the start without top indicator', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'choice', title: '连接模型服务商', options: manyOptions(19) },
    input: '',
    selectedIndex: 0,
  }
  const lines = renderConnect(data, 60, 14, theme)
  const out = lines.map(stripAnsi).join('\n')
  assert.match(out, /服务商 0[^0-9]/)
  assert.doesNotMatch(out, /↑ 以上还有/)
  assert.match(out, /↓ 以下还有/)
})

test('renderConnect: everything fits means no indicators', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'choice', title: '连接模型服务商', options: manyOptions(3) },
    input: '',
    selectedIndex: 2,
  }
  const out = renderConnect(data, 60, 30, theme).map(stripAnsi).join('\n')
  assert.doesNotMatch(out, /以上还有|以下还有/)
  assert.match(out, /服务商 2[^0-9]/)
})

test('renderConnect: mid-list cursor keeps the viewport centered (neighbors visible)', () => {
  const data: ConnectOverlayData = {
    view: { kind: 'choice', title: '连接模型服务商', options: manyOptions(19) },
    input: '',
    selectedIndex: 10,
  }
  const out = renderConnect(data, 60, 14, theme).map(stripAnsi).join('\n')
  assert.match(out, /服务商 10[^0-9]/, 'selected option visible')
  assert.match(out, /服务商 9[^0-9]/, 'option above visible — not glued to the bottom')
  assert.match(out, /服务商 11[^0-9]/, 'option below visible — not glued to the top')
  assert.match(out, /↑ 以上还有/)
  assert.match(out, /↓ 以下还有/)
})
