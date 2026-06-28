/**
 * Side panel rendering tests.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { renderSidePanel } from '../side-panel.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('renderSidePanel', () => {
  it('returns non-empty output with minimal input', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'deepseek-chat',
    }, theme)
    assert.ok(lines.length > 0, 'should produce at least one line')
  })

  it('includes model name in output', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'claude-opus',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('claude-opus'), `model name: ${all}`)
  })

  it('renders todo items', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [
        { id: '1', content: 'Fix the cache bug', status: 'in_progress' },
      ],
      workers: [],
      modelName: 'test',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('Fix the cache bug'), `todo item: ${all}`)
  })

  it('renders worker info', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [{
        workerId: 'wo_01',
        shortLabel: 'T1',
        parentToolId: 'tool_01',
        profile: 'code_scout',
        authority: 'tianquan',
        status: 'running',
        panelStatus: 'running',
        terminal: false,
        activity: 'reading files...',
        activityLog: [],
        elapsedMs: 5000,
      }],
      modelName: 'test',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('T1'), `worker label: ${all}`)
  })

  it('renders current tool info', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
      currentTool: { name: 'grep', elapsedMs: 2300 },
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('grep'), `tool name: ${all}`)
  })

  it('renders token gauge when tokens given', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
      estimatedTokens: 64_000,
      maxTokens: 128_000,
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('50%'), `token ratio: ${all}`)
  })

  it('renders domain glyph and name', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
      domainGlyph: '◇',
      domainName: '天枢',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('天枢'), `domain name: ${all}`)
    assert.ok(all.includes('◇'), `domain glyph: ${all}`)
  })

  it('each line does not exceed panel width', () => {
    for (const width of [24, 32]) {
      const lines = renderSidePanel({
        columns: width,
        todos: [
          { id: '1', content: 'A very long todo item that should be truncated or wrapped properly', status: 'in_progress' },
        ],
        workers: [{
          workerId: 'wo_01', shortLabel: 'T1', parentToolId: 'tool_01',
          profile: 'code_scout', authority: 'tianquan', status: 'running',
          panelStatus: 'running', terminal: false,
          activity: 'reading many files in the repository...',
          activityLog: [],
          elapsedMs: 5000,
        }],
        modelName: 'very-long-model-name-that-exceeds-panel',
        currentTool: { name: 'very-long-tool-name', elapsedMs: 1234567 },
        estimatedTokens: 123456789, maxTokens: 999999999,
        cacheHitRate: 0.8555,
        domainGlyph: '❂', domainName: '天枢测试星域',
      }, theme)
      for (const line of lines) {
        const w = stringWidth(stripAnsi(line))
        assert.ok(w <= width, `panel width=${width}: line display-width ${w} must be ≤ ${width}, got: "${stripAnsi(line)}"`)
      }
    }
  })

  it('handles empty state gracefully', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: '',
    }, theme)
    assert.ok(lines.length > 0, 'should still render something even with empty model')
    for (const line of lines) {
      assert.ok(!stripAnsi(line).includes('undefined'), 'no undefined in output')
    }
  })

  it('renders active plan section when pointer given', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
      activePlan: '<active-plan slug="p1" title="Rewrite ANSI renderer" path=".rivet/plans/p1.md">go</active-plan>',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('Rewrite ANSI renderer'), `plan title: ${all}`)
    assert.ok(all.includes('.rivet/plans/p1.md'), `plan path: ${all}`)
  })

  it('renders shortcuts hint', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('] toggle'), `toggle hint: ${all}`)
    assert.ok(all.includes('ctrl+x r open'), `open hint: ${all}`)
  })
})
