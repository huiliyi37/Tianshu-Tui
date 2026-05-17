import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginActivity,
  heartbeatActivity,
  completeActivity,
  clearActivity,
  failActivity,
  createIdleActivity,
  formatActivityDuration,
  formatThinkingSize,
  activityPhaseLabel,
  formatActivitySummary,
  classifyToolActivity,
  shouldBeginAnalyzing,
  shouldProjectActivity,
  toolActivityLabel,
  analysisLabelForTool,
} from '../activity-status.js'

describe('activity status lifecycle', () => {
  it('starts idle', () => {
    assert.deepEqual(createIdleActivity(1000), {
      phase: 'idle',
      startedAt: 1000,
      lastEventAt: 1000,
      status: 'idle',
    })
  })

  it('begins an activity with phase, label, size hint, and timestamps', () => {
    const activity = beginActivity(createIdleActivity(1000), 'thinking', 'Thinking', 2000, '12 chars')

    assert.equal(activity.phase, 'thinking')
    assert.equal(activity.label, 'Thinking')
    assert.equal(activity.startedAt, 2000)
    assert.equal(activity.lastEventAt, 2000)
    assert.equal(activity.sizeHint, '12 chars')
    assert.equal(activity.status, 'active')
  })

  it('heartbeats without resetting start time', () => {
    const activity = beginActivity(createIdleActivity(1000), 'tool', 'Running npm test', 2000)
    const next = heartbeatActivity(activity, 5000, { label: 'Running npm test', sizeHint: '3 lines' })

    assert.equal(next.startedAt, 2000)
    assert.equal(next.lastEventAt, 5000)
    assert.equal(next.label, 'Running npm test')
    assert.equal(next.sizeHint, '3 lines')
    assert.equal(next.status, 'active')
  })

  it('completion and failure freeze timestamps and preserve optional updates', () => {
    const activity = beginActivity(createIdleActivity(1000), 'mcp', 'Waiting for MCP context7', 2000)

    assert.deepEqual(completeActivity(activity, 8000, { label: 'MCP complete', sizeHint: '2 tools' }), {
      ...activity,
      label: 'MCP complete',
      sizeHint: '2 tools',
      completedAt: 8000,
      lastEventAt: 8000,
      status: 'completed',
    })

    assert.deepEqual(failActivity(activity, 9000, { label: 'MCP failed', sizeHint: 'timeout' }), {
      ...activity,
      label: 'MCP failed',
      sizeHint: 'timeout',
      completedAt: 9000,
      lastEventAt: 9000,
      status: 'failed',
    })
  })

  it('heartbeat, completion, and failure leave idle unchanged', () => {
    const idle = createIdleActivity(1000)

    assert.equal(heartbeatActivity(idle, 2000, { label: 'Still idle', sizeHint: 'ignored' }), idle)
    assert.equal(completeActivity(idle, 3000, { label: 'Complete idle', sizeHint: 'ignored' }), idle)
    assert.equal(failActivity(idle, 4000, { label: 'Fail idle', sizeHint: 'ignored' }), idle)
  })

  it('clears to idle at the provided time', () => {
    const activity = beginActivity(createIdleActivity(1000), 'streaming', 'Streaming answer', 2000)

    assert.deepEqual(clearActivity(activity, 7000), {
      phase: 'idle',
      startedAt: 7000,
      lastEventAt: 7000,
      status: 'idle',
    })
  })
})

describe('activity status formatting', () => {
  it('formats elapsed duration without fake progress', () => {
    assert.equal(formatActivityDuration(0), '0s')
    assert.equal(formatActivityDuration(59_000), '59s')
    assert.equal(formatActivityDuration(61_000), '1m 1s')
  })

  it('formats thinking size', () => {
    assert.equal(formatThinkingSize(999), '999 chars')
    assert.equal(formatThinkingSize(1500), '1.5k')
  })

  it('formats active activity with elapsed and size hint', () => {
    const activity = beginActivity(createIdleActivity(0), 'thinking', 'Thinking', 1000, '655 chars')
    assert.equal(formatActivitySummary(activity, 2000), 'Thinking… 1s · 655 chars')
  })

  it('adds no-update text after the stale threshold', () => {
    const activity = heartbeatActivity(
      beginActivity(createIdleActivity(0), 'tool', 'Reading src/tui/app.tsx', 1000),
      10_000,
    )
    assert.equal(formatActivitySummary(activity, 25_000), 'Reading src/tui/app.tsx… 24s · no update 15s')
  })

  it('formats completed and failed activity using frozen completion time', () => {
    const completed = completeActivity(
      beginActivity(createIdleActivity(0), 'thinking', 'Thinking', 1000, '655 chars'),
      129_000,
    )
    const failed = failActivity(beginActivity(createIdleActivity(0), 'tool', 'Running npm test', 1000), 11_000)

    assert.equal(formatActivitySummary(completed, 300_000), 'Thinking completed in 2m 8s (655 chars)')
    assert.equal(formatActivitySummary(failed, 300_000), 'Running npm test failed after 10s')
  })

  it('maps phases to concise labels', () => {
    assert.equal(activityPhaseLabel('streaming'), 'Streaming answer')
    assert.equal(activityPhaseLabel('compacting'), 'Compacting context')
    assert.equal(activityPhaseLabel('preflight'), 'Restoring session')
  })

  it('classifies MCP tools separately from generic tools', () => {
    assert.deepEqual(classifyToolActivity('mcp__context7__query-docs'), {
      phase: 'mcp',
      label: 'Waiting for MCP context7',
    })
  })

  it('keeps large-result analysis heuristic conservative', () => {
    assert.equal(shouldBeginAnalyzing({ toolName: 'read_file', resultLength: 20_000 }), true)
    assert.equal(shouldBeginAnalyzing({ toolName: 'read_file', resultLength: 500 }), false)
    assert.equal(shouldBeginAnalyzing({ toolName: 'bash', resultLength: 25_000 }), true)
  })
})

describe('activity projection cadence', () => {
  it('projects immediately when the text changes', () => {
    assert.equal(shouldProjectActivity({ previousText: 'Thinking… 1s', nextText: 'Thinking… 2s', previousAt: 1000, now: 1200 }), true)
  })

  it('skips unchanged text within the projection interval', () => {
    assert.equal(shouldProjectActivity({ previousText: 'Thinking… 1s', nextText: 'Thinking… 1s', previousAt: 1000, now: 1500 }), false)
  })

  it('allows unchanged text after one second for timer-driven stale updates', () => {
    assert.equal(shouldProjectActivity({ previousText: 'Thinking… 1s', nextText: 'Thinking… 1s', previousAt: 1000, now: 2200 }), true)
  })
})

describe('tool activity labels', () => {
  it('keeps file reads readable', () => {
    assert.equal(toolActivityLabel('read_file', 'read app.ts'), 'Reading app.ts')
  })

  it('keeps bash commands readable', () => {
    assert.equal(toolActivityLabel('bash', 'npm test -- src/tui'), 'Running npm test -- src/tui')
  })

  it('creates large-result analysis labels', () => {
    assert.equal(analysisLabelForTool('read_file', 'read app.ts'), 'Analyzing app.ts')
    assert.equal(analysisLabelForTool('bash', 'npm test'), 'Analyzing tool results')
  })
})
