import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTheme } from '../theme.js'
import { renderApprovalPreview, getApprovalRenderer } from '../format/approval-renderers.js'

const theme = getTheme(0)

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

describe('approval renderers', () => {
  it('bash: shows command and cwd', () => {
    const lines = renderApprovalPreview('bash', { command: 'npm test', cwd: '/proj' }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Command: npm test'))
    assert.ok(text.includes('CWD: /proj'))
  })

  it('bash: detects dangerous rm -rf /', () => {
    const lines = renderApprovalPreview('bash', { command: 'rm -rf /' }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Command: rm -rf /'))
    assert.ok(text.includes('High-risk command detected'))
  })

  it('bash: json fallback when command is not string', () => {
    const lines = renderApprovalPreview('bash', { args: ['ls'] }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('{"args":["ls"]}'))
  })

  it('write_file: shows path and content preview', () => {
    const lines = renderApprovalPreview('write_file', {
      file_path: 'src/foo.ts',
      content: 'line1\nline2\nline3\nline4\nline5',
    }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Path: src/foo.ts'))
    assert.ok(text.includes('5 lines'))
    assert.ok(text.includes('line1'))
    assert.ok(text.includes('+1 more lines'))
  })

  it('write_file: handles path alias', () => {
    const lines = renderApprovalPreview('write', { path: 'README.md', content: '' }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Path: README.md'))
  })

  it('edit_file: shows line change stats', () => {
    const lines = renderApprovalPreview('edit_file', {
      file_path: 'src/foo.ts',
      old_string: 'a\nb\nc',
      new_string: 'a\nX\nc',
    }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Path: src/foo.ts'))
    assert.ok(text.includes('3 lines removed'))
    assert.ok(text.includes('3 lines added'))
    assert.ok(text.includes('- a'))
    assert.ok(text.includes('+ X'))
  })

  it('edit_file: falls back when strings missing', () => {
    const lines = renderApprovalPreview('edit_file', { file_path: 'x.ts' }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Path: x.ts'))
  })

  it('delegate_task: shows objective and profile', () => {
    const lines = renderApprovalPreview('delegate_task', {
      objective: 'Refactor auth module',
      profile: 'code_scout',
    }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Objective: Refactor auth module'))
    assert.ok(text.includes('Profile: code_scout'))
  })

  it('delegate_batch: shows task count and previews', () => {
    const lines = renderApprovalPreview('delegate_batch', {
      tasks: [
        { objective: 'Task A' },
        { objective: 'Task B' },
        { objective: 'Task C' },
        { objective: 'Task D' },
      ],
      profile: 'patcher',
    }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Delegate 4 tasks'))
    assert.ok(text.includes('(profile: patcher)'))
    assert.ok(text.includes('1: Task A'))
    assert.ok(text.includes('+1 more tasks'))
  })

  it('web_fetch: shows url', () => {
    const lines = renderApprovalPreview('web_fetch', { url: 'https://example.com' }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('URL: https://example.com'))
  })

  it('web_search: shows query', () => {
    const lines = renderApprovalPreview('web_search', { query: 'node.js streams' }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Query: node.js streams'))
  })

  it('fallback: json summary for unknown tool', () => {
    const lines = renderApprovalPreview('custom_tool', { foo: 'bar' }, 60, theme)
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('→'))
    assert.ok(text.includes('{"foo":"bar"}'))
  })

  it('getApprovalRenderer returns fallback for unknown tools', () => {
    const r = getApprovalRenderer('unknown')
    const lines = r.render('unknown', { x: 1 }, 40, theme)
    assert.equal(lines.length, 1)
  })

  it('respects column budget', () => {
    const longCmd = 'a'.repeat(100)
    const lines = renderApprovalPreview('bash', { command: longCmd }, 20, theme)
    for (const line of lines) {
      const stripped = stripAnsi(line)
      // Leading space added by caller; renderer itself should not exceed columns-2
      assert.ok(stripped.length <= 18, `line too long: ${stripped.length}`)
    }
  })
})
