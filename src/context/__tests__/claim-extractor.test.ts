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

  it('extracts security_finding from bash with security-related output', () => {
    const ctx: ToolResultContext = {
      toolName: 'bash',
      input: { command: 'npm audit' },
      result: '3 vulnerabilities found\n  high: prototype-pollution in lodash',
      isError: false,
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
})
