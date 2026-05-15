import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ContextLedger } from '../../context/types.js'
import { buildVolatileBlock } from '../volatile.js'

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
    assert.doesNotMatch(block, /<session-memory/)
  })
})
