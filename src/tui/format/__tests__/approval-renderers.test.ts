import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatApprovalPrompt, renderApprovalPreview } from '../approval-renderers.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatApprovalPrompt', () => {
  it('renders inline prompt with tool name and cursor option list', () => {
    const lines = formatApprovalPrompt({
      toolName: 'bash',
      input: { command: 'ls -la' },
      columns: 60,
      selectedIndex: 0,
    }, theme)

    const plain = lines.map(stripAnsi)
    // No modal box borders in subtle style
    assert.ok(!plain[0]!.includes('┌'), 'no top border in subtle style')
    assert.ok(plain.some(l => l.includes('bash')), 'tool name shown')
    assert.ok(plain.some(l => l.includes('ls -la')), 'preview content')
    assert.ok(plain.some(l => l.includes('批准')), '批准 option')
    assert.ok(plain.some(l => l.includes('拒绝')), '拒绝 option')
    assert.ok(plain.some(l => l.includes('编辑 JSON')), '编辑 JSON option')
    assert.ok(plain.some(l => l.includes('解释风险')), '解释风险 option')
    // 光标行：selectedIndex=0 的批准行带 > 光标与编号
    assert.ok(plain.some(l => l.includes('> 1. 批准')), 'cursor on first option')
  })

  it('cursor moves with selectedIndex', () => {
    const lines = formatApprovalPrompt({
      toolName: 'bash',
      input: { command: 'ls' },
      columns: 60,
      selectedIndex: 2,
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('> 3. 编辑 JSON')), 'cursor on third option')
    assert.ok(!plain.some(l => l.includes('> 1. 批准')), 'first option not selected')
  })

  it('rememberOption inserts 「批准并记住此目录」between 编辑 and 解释风险', () => {
    const lines = formatApprovalPrompt({
      toolName: 'write_file',
      input: { file_path: '/tmp/x', content: 'x' },
      columns: 60,
      selectedIndex: 0,
      rememberOption: true,
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('批准并记住此目录 (r)')), 'remember option rendered')
    assert.ok(plain.some(l => l.includes('解释风险')), 'risk option still present when no risk shown')
    // 顺序：记住项在编辑与解释之间（index 3 of 5）
    const editIdx = plain.findIndex(l => l.includes('编辑 JSON'))
    const rememberIdx = plain.findIndex(l => l.includes('批准并记住'))
    const riskIdx = plain.findIndex(l => l.includes('解释风险'))
    assert.ok(editIdx >= 0 && rememberIdx > editIdx && riskIdx > rememberIdx, 'order: 编辑 < 记住 < 解释风险')
  })

  it('rememberOption with existing risk explanation drops the risk line but keeps remember', () => {
    const lines = formatApprovalPrompt({
      toolName: 'write_file',
      input: { file_path: '/tmp/x', content: 'x' },
      columns: 60,
      selectedIndex: 3,
      rememberOption: true,
      risk: { level: 'medium', lines: ['writes outside workspace'] },
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('批准并记住此目录 (r)')), 'remember option survives risk shown')
    assert.ok(!plain.some(l => l.includes('解释风险')), 'risk line gone once explanation shown')
    assert.ok(plain.some(l => l.includes('> 4. 批准并记住')), 'selectedIndex 3 → remember is 4th option')
  })

  it('fits within column width', () => {
    const lines = formatApprovalPrompt({
      toolName: 'write_file',
      input: { file_path: '/tmp/x', content: 'hello world' },
      columns: 60,
      selectedIndex: 0,
    }, theme)
    const widths = lines.map(l => stripAnsi(l).length)
    const maxWidth = Math.max(...widths)
    assert.ok(maxWidth <= 60, `max width ${maxWidth} <= 60`)
  })

  // 选项列表是竖排短行，窄终端天然不溢出；曾经 75 列的横向提示行已不存在。
  it('keeps every option visible without overflow at narrow widths', () => {
    for (const columns of [80, 60, 45, 30]) {
      const lines = formatApprovalPrompt({
        toolName: 'bash',
        input: { command: 'ls' },
        columns,
        selectedIndex: 0,
      }, theme)
      const plain = lines.map(stripAnsi)
      const over = plain.filter(l => l.length > columns)
      assert.deepEqual(over, [], `columns=${columns} 有行溢出`)
      const joined = plain.join('\n')
      for (const key of ['批准', '拒绝', '编辑 JSON', '解释风险']) {
        assert.ok(joined.includes(key), `columns=${columns} 丢了选项「${key}」`)
      }
    }
  })

  it('adapts to narrow terminals', () => {
    const lines = formatApprovalPrompt({
      toolName: 'bash',
      input: { command: 'ls' },
      columns: 45,
      selectedIndex: 0,
    }, theme)
    // prompt line (last line) may be slightly wider; main content lines should fit within columns
    const plainLines = lines.map(stripAnsi)
    const mainLines = plainLines.slice(0, -1)
    if (mainLines.length > 0) {
      const mainMax = Math.max(...mainLines.map(l => l.length))
      assert.ok(mainMax <= 45, `main lines max width ${mainMax} <= 45`)
    }
  })
})

describe('renderApprovalPreview', () => {
  it('renders bash command preview', () => {
    const lines = renderApprovalPreview('bash', { command: 'rm -rf /tmp/foo' }, 60, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.ok(plain.includes('rm -rf /tmp/foo'), 'command shown')
  })
})
