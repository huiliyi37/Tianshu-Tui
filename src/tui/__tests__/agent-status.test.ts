import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toolLabel, statusPhaseText } from '../tool-status.js'

describe('toolLabel', () => {
  it('keeps plain read_file labels concise', () => {
    assert.equal(toolLabel('read_file', { file_path: '/repo/src/app.ts' }), 'read app.ts')
  })

  it('shows read_file range arguments in the TUI label', () => {
    assert.equal(
      toolLabel('read_file', { file_path: '/repo/src/app.ts', offset: 100, limit: 50 }),
      'read app.ts · offset=100 limit=50',
    )
  })

  it('shows unexpected read_file arguments including empty strings', () => {
    assert.equal(
      toolLabel('read_file', { file_path: '/repo/.wolf/anatomy.md', pages: '' }),
      'read anatomy.md · pages=""',
    )
  })
})

describe('statusPhaseText', () => {
  it('prefers activity summary over derived phase labels', () => {
    assert.equal(
      statusPhaseText('Thinking… 42s · 655 chars', [], false),
      'Thinking… 42s · 655 chars',
    )
  })

  it('falls back to existing phase labels when activity summary is absent', () => {
    assert.equal(statusPhaseText(undefined, [], true), 'Thinking…')
    assert.equal(
      statusPhaseText(undefined, [{ id: '1', name: 'bash', label: 'npm test', done: false, error: false }], false),
      'Running…',
    )
  })
})
