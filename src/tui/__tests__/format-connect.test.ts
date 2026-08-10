import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderConnect, type ConnectOverlayData } from '../format/overlay.js'
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
