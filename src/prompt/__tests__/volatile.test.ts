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

describe('recent-commits XML section', () => {
  const base: VolatileContext = { cwd: '/project' }

  it('splits git status into <git-status> and <recent-commits>', () => {
    const ctx: VolatileContext = {
      ...base,
      gitStatus: 'M src/main.ts\nRecent commits:\na1b2c3d feat: add feature\nd4e5f6a fix: bug',
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('<git-status>'))
    assert.ok(block.includes('M src/main.ts'))
    assert.ok(block.includes('<recent-commits>'))
    assert.ok(block.includes('a1b2c3d feat: add feature'))
    assert.ok(!block.includes('Recent commits:'))
  })

  it('renders only <git-status> when no commits section', () => {
    const ctx: VolatileContext = {
      ...base,
      gitStatus: 'M src/main.ts\n?? new-file.ts',
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('<git-status>'))
    assert.ok(!block.includes('<recent-commits>'))
  })

  it('escapes XML in commit messages', () => {
    const ctx: VolatileContext = {
      ...base,
      gitStatus: 'Recent commits:\nabc fix: <script>alert(1)</script>',
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('&lt;script&gt;'))
    assert.ok(!block.includes('<script>'))
  })
})

describe('behavior-mirror XML section', () => {
  const base: VolatileContext = { cwd: '/project' }

  it('renders <behavior-mirror> when provided', () => {
    const ctx: VolatileContext = {
      ...base,
      behaviorMirror: 'You have edited auth.ts 3 times. What is the root cause?',
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('<behavior-mirror>'))
    assert.ok(block.includes('auth.ts 3 times'))
    assert.ok(block.includes('</behavior-mirror>'))
  })

  it('omits when null or undefined', () => {
    assert.ok(!buildVolatileBlock({ ...base, behaviorMirror: null }).includes('<behavior-mirror>'))
    assert.ok(!buildVolatileBlock(base).includes('<behavior-mirror>'))
  })

  it('escapes XML in mirror text', () => {
    const ctx: VolatileContext = {
      ...base,
      behaviorMirror: 'Error: "type" is not assignable to <T>',
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('&lt;T&gt;'))
    assert.ok(block.includes('&quot;type&quot;'))
  })
})

describe('decisions XML section', () => {
  const base: VolatileContext = { cwd: '/project' }

  it('renders <decisions> with entries', () => {
    const ctx: VolatileContext = {
      ...base,
      decisions: ['use middleware pattern for auth', 'split loop into harness + orchestrator'],
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('<decisions recent="2">'))
    assert.ok(block.includes('<decision>use middleware pattern for auth</decision>'))
    assert.ok(block.includes('</decisions>'))
  })

  it('omits when empty or undefined', () => {
    assert.ok(!buildVolatileBlock({ ...base, decisions: [] }).includes('<decisions>'))
    assert.ok(!buildVolatileBlock(base).includes('<decisions>'))
  })

  it('escapes XML in decision text', () => {
    const ctx: VolatileContext = {
      ...base,
      decisions: ['use <Strategy> pattern'],
    }
    const block = buildVolatileBlock(ctx)
    assert.ok(block.includes('&lt;Strategy&gt;'))
  })
})
