import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextClaimStore } from '../../context/claim-store.js'
import { createRememberTool, type RememberContext } from '../remember.js'

describe('remember tool', () => {
  const makeCtx = (sessionId: string, turn: number): RememberContext => ({
    sessionId,
    getTurn: () => turn,
  })

  it('stores a decision claim and returns confirmation with claim id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-remember-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const ctx = makeCtx('session-1', 3)
      const tool = createRememberTool(store, ctx)

      const result = await tool.execute({
        toolUseId: 't1',
        input: { kind: 'decision', text: 'Use incremental migration instead of big-bang rewrite' },
        cwd: dir,
      })

      assert.ok(result.content?.includes('decision'), 'should show claim kind')
      assert.ok(result.content?.includes('incremental migration'), 'should show claim text')

      // Verify claim is in the store
      const claims = store.listClaims()
      assert.equal(claims.length, 1)
      assert.equal(claims[0]!.kind, 'decision')
      assert.equal(claims[0]!.scope, 'session')
      assert.ok(claims[0]!.text.includes('incremental migration'))
      assert.ok(claims[0]!.source.actor === 'assistant', 'actor should be assistant')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stores a project-scoped claim that persists across sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-remember-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const ctx = makeCtx('session-1', 1)
      const tool = createRememberTool(store, ctx)

      tool.execute({
        toolUseId: 't2',
        input: {
          kind: 'project_rule',
          text: 'All API clients must implement StreamClient interface',
          scope: 'project',
          confidence: 0.95,
          tags: ['architecture', 'api'],
        },
        cwd: dir,
      })

      const claims = store.listClaims()
      assert.equal(claims.length, 1)
      assert.equal(claims[0]!.scope, 'project')
      assert.equal(claims[0]!.kind, 'project_rule')
      assert.equal(claims[0]!.confidence, 0.95)
      assert.deepEqual(claims[0]!.tags, ['architecture', 'api'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stores a failure_pattern claim with low confidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-remember-'))
    try {
      const store = new ContextClaimStore(dir, 'session-2')
      const ctx = makeCtx('session-2', 5)
      const tool = createRememberTool(store, ctx)

      tool.execute({
        toolUseId: 't3',
        input: {
          kind: 'failure_pattern',
          text: 'tsx --test fails when filter contains special regex chars — escape before passing',
          confidence: 0.6,
        },
        cwd: dir,
      })

      const claims = store.listClaims()
      assert.equal(claims.length, 1)
      assert.equal(claims[0]!.kind, 'failure_pattern')
      assert.equal(claims[0]!.confidence, 0.6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates identical claims (same kind + scope + text + session)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-remember-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const ctx = makeCtx('session-1', 1)
      const tool = createRememberTool(store, ctx)

      tool.execute({
        toolUseId: 't4a',
        input: { kind: 'decision', text: 'Cache key should include provider name' },
        cwd: dir,
      })
      tool.execute({
        toolUseId: 't4b',
        input: { kind: 'decision', text: 'Cache key should include provider name' },
        cwd: dir,
      })

      // Should only create one claim (dedup by text + kind + scope + sessionId)
      const claims = store.listClaims()
      assert.equal(claims.length, 1, 'duplicate claim should be deduplicated')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stores verification_fact claims', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-remember-'))
    try {
      const store = new ContextClaimStore(dir, 'session-3')
      const ctx = makeCtx('session-3', 7)
      const tool = createRememberTool(store, ctx)

      tool.execute({
        toolUseId: 't5',
        input: {
          kind: 'verification_fact',
          text: '48 API tests pass with the abort-reader fix applied to all 3 clients',
          confidence: 0.95,
        },
        cwd: dir,
      })

      const claims = store.listClaims()
      assert.equal(claims[0]!.kind, 'verification_fact')
      assert.ok(claims[0]!.text.includes('48 API tests'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requires no approval and is concurrency safe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-remember-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const tool = createRememberTool(store)

      assert.equal(tool.requiresApproval({ input: { kind: 'decision', text: 'x' }, toolUseId: 't', cwd: '/' }), false)
      assert.equal(tool.isConcurrencySafe(), true)
      assert.equal(tool.isEnabled(), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
