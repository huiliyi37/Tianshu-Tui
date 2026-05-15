import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ContextLedger } from '../../context/types.js'
import { buildVolatileBlock, type VolatileContext } from '../volatile.js'

function ledger(): ContextLedger {
  return {
    sessionId: 'test',
    transcriptPath: '',
    rounds: [],
    anchors: [],
    workingSet: [],
    compactedSpans: [],
    sessionMemory: null,
    tokenBudget: { estimatedTokens: 1200, maxTokens: 10000, warningThreshold: 5000, compactionState: 'healthy' },
    apiInvariantStatus: { totalRounds: 3, okRounds: 3, repairedRounds: 0, brokenRounds: 0, orphanToolUse: [], orphanToolResult: [] },
  }
}

describe('volatile context layers', () => {
  it('renders environment, ledger, working set, and memory as stable XML sections', () => {
    const block = buildVolatileBlock({
      cwd: '/repo',
      rivetMd: 'Use TDD.',
      gitStatus: 'M src/main.tsx',
      workingSet: ['src/main.tsx'],
      contextLedger: ledger(),
      sessionMemoryBlock: '<session-memory session_id="s1"><entry id="m1" created_at="1" source="manual">Keep rounds safe.</entry></session-memory>',
    })

    assert.match(block, /<context>/)
    assert.match(block, /<environment/)
    assert.match(block, /<context-ledger health="healthy" api_safe="true"/)
    assert.match(block, /<working-set>/)
    assert.match(block, /<session-memory/)
    assert.match(block, /<git-status>/)
    assert.match(block, /<project-instructions>/)
  })

  it('omits sections when no data is provided', () => {
    const block = buildVolatileBlock({ cwd: '/repo' })

    assert.match(block, /<context>/)
    assert.match(block, /<environment/)
    assert.doesNotMatch(block, /<working-set>/)
    assert.doesNotMatch(block, /<context-ledger/)
    assert.doesNotMatch(block, /<session-memory>/)
  })
})

describe('tool-history XML section', () => {
  const base: VolatileContext = { cwd: '/project' }

  it('renders <tool-history> with entries', () => {
    const ctx: VolatileContext = {
      ...base,
      toolHistory: [
        { tool: 'edit_file', target: 'src/auth.ts', status: 'success' },
        { tool: 'run_tests', target: 'auth.test.ts', status: 'failed', error: 'timeout' },
      ],
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('<tool-history'))
    assert.ok(block.includes('<tool-summary tool="edit_file"'))
    assert.ok(block.includes('status="success"'))
    assert.ok(block.includes('status="failed"'))
    assert.ok(block.includes('error="timeout"'))
    assert.ok(block.includes('</tool-history>'))
  })

  it('omits <tool-history> when empty or undefined', () => {
    assert.ok(!buildVolatileBlock({ ...base, toolHistory: [] }).includes('<tool-history'))
    assert.ok(!buildVolatileBlock(base).includes('<tool-history'))
  })

  it('escapes XML special chars in targets', () => {
    const ctx: VolatileContext = {
      ...base,
      toolHistory: [{ tool: 'bash', target: 'echo "hello <world>"', status: 'success' }],
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('&lt;world&gt;'))
    assert.ok(!block.includes('<world>'))
  })

  it('includes recent count attribute', () => {
    const ctx: VolatileContext = {
      ...base,
      toolHistory: [
        { tool: 'a', target: 'b', status: 'success' },
        { tool: 'c', target: 'd', status: 'success' },
        { tool: 'e', target: 'f', status: 'success' },
      ],
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('recent="3"'))
  })

  it('preserves existing sections alongside tool-history', () => {
    const ctx: VolatileContext = {
      ...base,
      gitStatus: 'M src/foo.ts',
      workingSet: ['src/foo.ts'],
      toolHistory: [{ tool: 'edit_file', target: 'src/foo.ts', status: 'success' }],
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('<git-status>'))
    assert.ok(block.includes('<working-set>'))
    assert.ok(block.includes('<tool-history'))
  })

  it('handles running status', () => {
    const ctx: VolatileContext = {
      ...base,
      toolHistory: [{ tool: 'run_tests', target: 'all', status: 'running' }],
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('status="running"'))
  })
})
