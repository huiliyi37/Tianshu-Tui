import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPlanPicker, type PlanPickerData } from '../format/overlay.js'
import { getTheme } from '../theme.js'

function stripAnsi(s: string): string { return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '') }

const theme = getTheme()

function makeData(overrides: Partial<PlanPickerData> = {}): PlanPickerData {
  return {
    entries: [
      { slug: 'fix-memory-leak', title: 'Fix Memory Leak', status: 'submitted', createdAt: '2026-07-04 13:00' },
      { slug: 'perm-unify', title: '权限入口三档统一', status: 'submitted', createdAt: '2026-07-04 12:00', options: ['Manual', 'Auto', 'YOLO'] },
      { slug: 'old-plan', title: 'Old Plan', status: 'executed', createdAt: '2026-07-01 09:00' },
    ],
    selectedIndex: 0,
    ...overrides,
  }
}

test('renderPlanPicker: renders title and all plan titles', () => {
  const plain = renderPlanPicker(makeData(), 70, 20, theme).map(stripAnsi).join('\n')
  assert.ok(plain.includes('选择要批准执行的计划'), 'title present')
  assert.ok(plain.includes('Fix Memory Leak'))
  assert.ok(plain.includes('权限入口三档统一'))
  assert.ok(plain.includes('Old Plan'))
})

test('renderPlanPicker: selected entry has ▶ cursor and shows meta', () => {
  const plain = renderPlanPicker(makeData({ selectedIndex: 1 }), 70, 20, theme).map(stripAnsi)
  const sel = plain.find(l => l.includes('权限入口三档统一'))
  assert.ok(sel && sel.includes('▶'), 'selected entry has cursor')
  const joined = plain.join('\n')
  assert.ok(joined.includes('perm-unify'), 'selected slug shown in meta')
  assert.ok(joined.includes('Manual / Auto / YOLO'), 'options listed for multi-approach plan')
})

test('renderPlanPicker: status icons reflect plan status', () => {
  const plain = renderPlanPicker(makeData(), 70, 20, theme).map(stripAnsi).join('\n')
  assert.ok(plain.includes('📋'), 'submitted icon present')
  assert.ok(plain.includes('🏁'), 'executed icon present')
})

test('renderPlanPicker: footer shows navigation hints', () => {
  const plain = renderPlanPicker(makeData(), 70, 20, theme).map(stripAnsi).join('\n')
  assert.ok(plain.includes('↑↓'))
  assert.ok(plain.includes('Enter'))
  assert.ok(plain.includes('Esc'))
})

test('renderPlanPicker: empty entries does not crash', () => {
  const lines = renderPlanPicker({ entries: [], selectedIndex: 0 }, 50, 10, theme)
  assert.ok(lines.length > 0)
  const plain = lines.map(stripAnsi).join('\n')
  assert.ok(plain.includes('无待批计划'))
})

test('renderPlanPicker: no line exceeds width', () => {
  const lines = renderPlanPicker(makeData({ selectedIndex: 1 }), 50, 20, theme)
  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 50, `line too long: ${stripAnsi(line).length}`)
  }
})
