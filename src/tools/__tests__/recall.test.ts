import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecallTool } from '../recall.js'
import { ContextClaimStore } from '../../context/claim-store.js'
import type { ClaimProposal } from '../../context/claims.js'

function proposal(text: string, kind: ClaimProposal['kind'] = 'file_observation'): ClaimProposal {
  return {
    kind,
    scope: 'session',
    text,
    confidence: 0.8,
    fitness: 4,
    source: { actor: 'tool', sessionId: 'test', turn: 1, eventId: `e:${text.slice(0, 8)}` },
    evidence: [{ id: `ev:${text.slice(0, 8)}`, kind: 'tool_result', summary: text, createdAt: Date.now() }],
    createdAt: Date.now(),
    tags: ['test'],
  }
}

describe('recall tool', () => {
  it('searches claims by text keyword', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('config uses port 3000'))
      store.propose(proposal('database connection string'))

      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'port' }, cwd: '/tmp' })

      assert.ok(result.content.includes('port 3000'))
      assert.ok(!result.content.includes('database'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('filters by kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('test passed', 'verification_fact'))
      store.propose(proposal('test also passed', 'file_observation'))

      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'test', kind: 'verification_fact' }, cwd: '/tmp' })

      assert.ok(result.content.includes('test passed'))
      assert.ok(!result.content.includes('also passed'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns message when no results found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'nonexistent' }, cwd: '/tmp' })

      assert.ok(result.content.includes('No claims found'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects limit parameter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      for (let i = 0; i < 10; i++) {
        store.propose(proposal(`observation number ${i}`))
      }

      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'observation', limit: 3 }, cwd: '/tmp' })

      const matches = result.content.split('[claim:').length - 1
      assert.equal(matches, 3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
