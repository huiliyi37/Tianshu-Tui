import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStructuredHandoff, STRUCTURED_HANDOFF_SECTIONS } from '../compaction-controller.js'

describe('buildStructuredHandoff', () => {
  it('includes all 9 required sections', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: 'testing compaction',
        completed: ['added tests'],
        remaining: ['fix bugs'],
        decisions: ['use regex for extraction'],
      },
      turnCount: 42,
      filesSeen: ['src/agent/context.ts', 'src/compact/prune.ts'],
      reasoningSnippet: 'We should trim at append time',
      errorCount: 0,
      errors: [],
      toolHistory: [
        { tool: 'read_file', target: 'src/agent/context.ts', status: 'success' },
        { tool: 'edit_file', target: 'src/agent/context.ts', status: 'success' },
      ],
    })

    assert.equal(STRUCTURED_HANDOFF_SECTIONS.length, 9, 'handoff section contract must have 9 sections')
    for (const section of STRUCTURED_HANDOFF_SECTIONS) {
      assert.ok(
        handoff.includes(section),
        `handoff should contain section: "${section}"`,
      )
    }
  })

  it('includes file paths with tool accessories', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: 'test',
        completed: [],
        remaining: [],
        decisions: [],
      },
      turnCount: 1,
      filesSeen: ['src/agent/context.ts'],
      reasoningSnippet: '',
      errorCount: 0,
      errors: [],
      toolHistory: [
        { tool: 'read_file', target: 'src/agent/context.ts', status: 'success' },
      ],
    })

    assert.ok(handoff.includes('src/agent/context.ts'), 'should mention file path')
    assert.ok(handoff.includes('[read_file]'), 'should annotate file path with tool accessory')
  })

  it('includes error and fix sections when errors exist', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: 'fixing bugs',
        completed: [],
        remaining: [],
        decisions: [],
      },
      turnCount: 10,
      filesSeen: [],
      reasoningSnippet: '',
      errorCount: 2,
      errors: [
        { turn: 5, tool: 'bash', target: 'npm test', errorClass: 'exit_code', summary: 'tests failed' },
        { turn: 8, tool: 'edit_file', target: 'src/foo.ts', errorClass: 'not_found', summary: 'file missing' },
      ],
      toolHistory: [],
    })

    assert.ok(handoff.includes('4. 错误与修复'), 'should have error section')
    assert.ok(handoff.includes('npm test'), 'should mention first error')
    assert.ok(handoff.includes('src/foo.ts'), 'should mention second error')
  })

  it('preserves retry success marker in tool history', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: 'test retry status',
        completed: [],
        remaining: [],
        decisions: [],
      },
      turnCount: 2,
      filesSeen: [],
      reasoningSnippet: '',
      errorCount: 0,
      errors: [],
      toolHistory: [
        { tool: 'edit_file', target: 'src/agent/context.ts', status: 'retried-success' },
      ],
    })

    assert.match(handoff, /ok\*/, 'should preserve retried-success as ok*')
  })

  it('handles empty state gracefully', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: '',
        completed: [],
        remaining: [],
        decisions: [],
      },
      turnCount: 0,
      filesSeen: [],
      reasoningSnippet: '',
      errorCount: 0,
      errors: [],
      toolHistory: [],
    })

    for (const section of STRUCTURED_HANDOFF_SECTIONS) {
      assert.ok(handoff.includes(section), `handoff should contain section: "${section}"`)
    }
    assert.ok(handoff.startsWith('<session-handoff>'), 'should start with session-handoff tag')
  })

  it('renders the collaboration-stance section when stanceSummary is present', () => {
    const handoff = buildStructuredHandoff({
      taskState: { current: 't', completed: [], remaining: [], decisions: [] },
      turnCount: 1, filesSeen: [], reasoningSnippet: '', errorCount: 0, errors: [], toolHistory: [],
      stanceSummary: '本会话姿态轨迹：仁(质疑而非附和)×2',
    })
    assert.match(handoff, /协作姿态（从行为轨迹涌现/)
    assert.match(handoff, /仁\(质疑而非附和\)×2/)
  })

  it('omits the stance section when stanceSummary is null', () => {
    const handoff = buildStructuredHandoff({
      taskState: { current: 't', completed: [], remaining: [], decisions: [] },
      turnCount: 1, filesSeen: [], reasoningSnippet: '', errorCount: 0, errors: [], toolHistory: [],
      stanceSummary: null,
    })
    assert.doesNotMatch(handoff, /协作姿态/)
  })
})
