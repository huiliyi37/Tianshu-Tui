import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractClaimsFromToolResult, type ToolResultContext } from '../claim-extractor.js'

describe('claim-extractor', () => {
  const meta = { sessionId: 'session-1', turn: 3, eventId: 'turn-3:tool' }

  it('extracts file_observation from read_file result', () => {
    const ctx: ToolResultContext = {
      toolName: 'read_file',
      input: { file_path: '/repo/src/config.ts' },
      result: 'export const MAX_RETRIES = 3\nexport const TIMEOUT = 5000',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'file_observation')
    assert.equal(proposals[0]!.scope, 'session')
    assert.ok(proposals[0]!.text.includes('config.ts'))
    assert.ok(proposals[0]!.text.includes('MAX_RETRIES'))
    assert.ok(proposals[0]!.text.includes('TIMEOUT'))
    assert.ok(proposals[0]!.evidence[0]!.path === '/repo/src/config.ts')
    assert.ok(proposals[0]!.expiresAt! > Date.now())
  })

  it('extracts failure_pattern from run_tests error', () => {
    const ctx: ToolResultContext = {
      toolName: 'run_tests',
      input: { command: 'npm test' },
      result: 'FAIL src/__tests__/auth.test.ts\n  ✗ login rejects invalid token\n    Error: expected 401 got 200',
      isError: true,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'failure_pattern')
    assert.ok(proposals[0]!.text.includes('auth.test.ts'))
    assert.equal(proposals[0]!.confidence, 0.8)
  })

  it('extracts verification_fact from run_tests success', () => {
    const ctx: ToolResultContext = {
      toolName: 'run_tests',
      input: { command: 'npm test' },
      result: 'Tests: 797 pass, 0 fail\nDuration: 9.2s',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'verification_fact')
    assert.ok(proposals[0]!.text.includes('797 pass'))
  })

  it('skips grep/glob results (too noisy)', () => {
    const ctx: ToolResultContext = {
      toolName: 'grep',
      input: { pattern: 'TODO' },
      result: 'src/a.ts:5: // TODO fix\nsrc/b.ts:10: // TODO later',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 0)
  })

  it('extracts security_finding from bash with security-related output and error', () => {
    const ctx: ToolResultContext = {
      toolName: 'bash',
      input: { command: 'npm audit' },
      result: '3 vulnerabilities found\n  high: prototype-pollution in lodash',
      isError: true,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'security_finding')
  })

  it('assigns TTL based on claim kind', () => {
    const ctx: ToolResultContext = {
      toolName: 'read_file',
      input: { file_path: '/repo/src/a.ts' },
      result: 'const x = 1',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    const ttl = proposals[0]!.expiresAt! - proposals[0]!.createdAt
    // file_observation TTL = 30 minutes
    assert.ok(ttl >= 29 * 60_000 && ttl <= 31 * 60_000)
  })

  it('skips empty or tiny results', () => {
    const ctx: ToolResultContext = {
      toolName: 'read_file',
      input: { file_path: '/repo/src/a.ts' },
      result: '',
      isError: false,
    }
    assert.equal(extractClaimsFromToolResult(ctx, meta).length, 0)
  })

  it('skips read_file errors', () => {
    const ctx: ToolResultContext = {
      toolName: 'read_file',
      input: { file_path: '/repo/src/a.ts' },
      result: 'ENOENT: file not found',
      isError: true,
    }
    assert.equal(extractClaimsFromToolResult(ctx, meta).length, 0)
  })

  it('deduplicates file_observation when path already observed', () => {
    const ctx: ToolResultContext = {
      toolName: 'read_file',
      input: { file_path: '/repo/src/config.ts' },
      result: 'export const PORT = 3000',
      isError: false,
    }
    const existing = new Set(['/repo/src/config.ts'])
    const proposals = extractClaimsFromToolResult(ctx, meta, existing)
    assert.equal(proposals.length, 0)
  })

  it('allows file_observation for unobserved paths', () => {
    const ctx: ToolResultContext = {
      toolName: 'read_file',
      input: { file_path: '/repo/src/new.ts' },
      result: 'export const X = 1',
      isError: false,
    }
    const existing = new Set(['/repo/src/config.ts'])
    const proposals = extractClaimsFromToolResult(ctx, meta, existing)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'file_observation')
  })

  it('does not extract security_finding from clean npm audit', () => {
    const ctx: ToolResultContext = {
      toolName: 'bash',
      input: { command: 'npm audit' },
      result: 'found 0 vulnerabilities',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 0)
  })

  it('extracts security_finding when bash audit has errors', () => {
    const ctx: ToolResultContext = {
      toolName: 'bash',
      input: { command: 'npm audit' },
      result: 'found 3 vulnerabilities\nhigh: prototype-pollution in lodash',
      isError: true,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'security_finding')
  })

  it('extracts failure from bash running tests', () => {
    const ctx: ToolResultContext = {
      toolName: 'bash',
      input: { command: 'npm test -- --grep auth' },
      result: 'FAIL src/auth.test.ts\n  ✗ should reject expired tokens',
      isError: true,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'failure_pattern')
  })

  // ── Commit fact extraction ──

  it('extracts decision claim from git commit result', () => {
    const ctx: ToolResultContext = {
      toolName: 'git',
      input: { action: 'commit', message: 'fix: restore hash in show-stat readback' },
      result: '[feat/knowledge-manifest-minimal abc1234] fix: restore hash in show-stat readback\n 2 files changed, 10 insertions(+), 2 deletions(-)\n\n--- actual changes (git show --stat) ---\nabc1234 (HEAD -> feat/knowledge-manifest-minimal)\n src/tools/git.ts | 3 ++-\n 1 file changed, 3 insertions(+), 2 deletions(-)',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'decision')
    assert.equal(proposals[0]!.scope, 'project')
    assert.ok(proposals[0]!.tags.includes('commit_fact'))
    assert.match(proposals[0]!.text, /abc1234/)
    assert.match(proposals[0]!.text, /restore hash/)
    assert.equal(proposals[0]!.expiresAt, undefined) // Infinity TTL via decision kind
  })

  it('extracts decision claim from deliver_task commit result', () => {
    const ctx: ToolResultContext = {
      toolName: 'deliver_task',
      input: { commit: true, message: 'fix: scoped commit' },
      result: 'Delivery Gate: GREEN\n\n✅ Scoped commit created with message: "fix: scoped commit"\n   Files: src/a.ts, src/b.ts\n   [main def5678] fix: scoped commit\n 2 files changed, 5 insertions(+)\n\n--- actual changes (git show --stat) ---\ndef5678 (HEAD -> main)\n src/a.ts | 3 ++-\n src/b.ts | 2 +-\n 2 files changed, 5 insertions(+), 2 deletions(-)',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'decision')
    assert.equal(proposals[0]!.scope, 'project')
    assert.ok(proposals[0]!.tags.includes('commit_fact'))
    assert.match(proposals[0]!.text, /def5678/)
  })

  it('does not extract claim from failed commit', () => {
    const ctx: ToolResultContext = {
      toolName: 'git',
      input: { action: 'commit', message: 'test' },
      result: 'git commit failed: nothing to commit',
      isError: true,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 0)
  })

  it('does not extract claim from non-commit git commands', () => {
    const ctx: ToolResultContext = {
      toolName: 'git',
      input: { action: 'log', maxCount: 5 },
      result: 'abc1234 fix: something\ndef5678 feat: other',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 0)
  })
})
