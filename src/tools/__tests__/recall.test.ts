import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecallTool, type RecallContext } from '../recall.js'
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

      assert.ok(result.content.includes('No claims or knowledge found'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('searches project knowledge using tool cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-knowledge-'))
    try {
      const knowledgeDir = join(cwd, '.rivet', 'knowledge')
      mkdirSync(knowledgeDir, { recursive: true })
      writeFileSync(
        join(knowledgeDir, 'project-memory.md'),
        '### Curated project memory\n**Claim**: Project memory should be recalled on demand.\n',
        'utf-8',
      )

      const store = new ContextClaimStore(dir, 'session-1')
      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'recalled' }, cwd })

      assert.ok(result.content.includes('Project knowledge'))
      assert.ok(result.content.includes('Project memory should be recalled on demand'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('searches the knowledge manifest on demand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-knowledge-manifest-'))
    try {
      const knowledgeDir = join(cwd, '.rivet', 'knowledge')
      mkdirSync(knowledgeDir, { recursive: true })
      writeFileSync(
        join(knowledgeDir, 'manifest.md'),
        '### Prompt and memory hygiene\n- path: docs/superpowers/plans/2026-05-27-项目记忆按需召回.md\n- contract: project memory is recalled on demand via manifest.\n',
        'utf-8',
      )

      const store = new ContextClaimStore(dir, 'session-1')
      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'manifest' }, cwd })

      assert.ok(result.content.includes('Project knowledge'))
      assert.ok(result.content.includes('Prompt and memory hygiene'))
      assert.ok(result.content.includes('manifest'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('searches structured project memory jsonl using tool cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-memory-jsonl-'))
    try {
      const knowledgeDir = join(cwd, '.rivet', 'knowledge')
      mkdirSync(knowledgeDir, { recursive: true })
      writeFileSync(
        join(knowledgeDir, 'memory.jsonl'),
        JSON.stringify({
          id: 'mem-decision-1',
          kind: 'decision',
          text: 'Use guided retrieval instead of pure recall-only memory.',
          confidence: 0.95,
          createdAt: 2,
          source: 'test',
        }) + '\n' + JSON.stringify({
          id: 'mem-file-1',
          kind: 'file_observation',
          text: 'recall.ts also searches local structured memory.',
          confidence: 0.6,
          createdAt: 1,
          source: 'test',
        }) + '\n',
        'utf-8',
      )

      const store = new ContextClaimStore(dir, 'session-1')
      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'guided' }, cwd })

      assert.ok(result.content.includes('Project memory'))
      assert.ok(result.content.includes('Use guided retrieval instead of pure recall-only memory.'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('filters structured project memory by kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-memory-jsonl-'))
    try {
      const knowledgeDir = join(cwd, '.rivet', 'knowledge')
      mkdirSync(knowledgeDir, { recursive: true })
      writeFileSync(
        join(knowledgeDir, 'memory.jsonl'),
        JSON.stringify({
          id: 'mem-decision-1',
          kind: 'decision',
          text: 'guided retrieval is a project decision',
          confidence: 0.95,
          createdAt: 2,
          source: 'test',
        }) + '\n' + JSON.stringify({
          id: 'mem-file-1',
          kind: 'file_observation',
          text: 'guided retrieval implementation detail',
          confidence: 0.6,
          createdAt: 1,
          source: 'test',
        }) + '\n',
        'utf-8',
      )

      const store = new ContextClaimStore(dir, 'session-1')
      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'guided', kind: 'decision' }, cwd })

      assert.ok(result.content.includes('project decision'))
      assert.ok(!result.content.includes('implementation detail'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
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

  it('records consumer on matched claims when context provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('config uses port 3000'))

      const ctx: RecallContext = { sessionId: 'session-1', getTurn: () => 5 }
      const tool = createRecallTool(store, ctx)
      await tool.execute({ toolUseId: 't1', input: { query: 'port' }, cwd: '/tmp' })

      const claims = store.listClaims()
      assert.ok(claims[0]!.consumers.length >= 1)
      assert.ok(claims[0]!.consumers.some(c => c.id.includes('recall')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('boosts fitness on matched claims (capped at 10)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('config uses port 3000'))

      const ctx: RecallContext = { sessionId: 'session-1', getTurn: () => 3 }
      const tool = createRecallTool(store, ctx)
      await tool.execute({ toolUseId: 't1', input: { query: 'port' }, cwd: '/tmp' })

      const claims = store.listClaims()
      assert.equal(claims[0]!.fitness, 5) // original 4 + 1 boost
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not boost fitness beyond cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose({
        ...proposal('high fitness claim'),
        fitness: 10,
      })

      const ctx: RecallContext = { sessionId: 'session-1', getTurn: () => 1 }
      const tool = createRecallTool(store, ctx)
      await tool.execute({ toolUseId: 't1', input: { query: 'high' }, cwd: '/tmp' })

      const claims = store.listClaims()
      assert.equal(claims[0]!.fitness, 10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
