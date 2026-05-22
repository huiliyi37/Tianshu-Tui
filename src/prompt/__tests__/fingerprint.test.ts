import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeFingerprint,
  detectDrift,
} from '../fingerprint.js'
import type { ToolDefinition } from '../../api/types.js'

const SAMPLE_TOOLS: ToolDefinition[] = [
  { name: 'bash', description: 'Run shell commands', input_schema: { type: 'object', properties: {} } },
  { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'write_file', description: 'Write a file', input_schema: { type: 'object', properties: {} } },
]

describe('computeFingerprint', () => {
  it('generates deterministic SHA-256 fingerprints', () => {
    const fp1 = computeFingerprint('system prompt v1', SAMPLE_TOOLS)
    const fp2 = computeFingerprint('system prompt v1', SAMPLE_TOOLS)

    assert.equal(fp1.systemSha256, fp2.systemSha256)
    assert.equal(fp1.toolsSha256, fp2.toolsSha256)
    assert.equal(fp1.combinedSha256, fp2.combinedSha256)
  })

  it('detects system prompt changes', () => {
    const fp1 = computeFingerprint('system prompt v1', SAMPLE_TOOLS)
    const fp2 = computeFingerprint('system prompt v2', SAMPLE_TOOLS)

    assert.notEqual(fp1.combinedSha256, fp2.combinedSha256)
    assert.notEqual(fp1.systemSha256, fp2.systemSha256)
    // tools unchanged
    assert.equal(fp1.toolsSha256, fp2.toolsSha256)
  })

  it('is stable regardless of tool registration order', () => {
    const reversed = [...SAMPLE_TOOLS].reverse()
    const fp1 = computeFingerprint('system', SAMPLE_TOOLS)
    const fp2 = computeFingerprint('system', reversed)

    assert.equal(fp1.toolsSha256, fp2.toolsSha256)
    assert.equal(fp1.combinedSha256, fp2.combinedSha256)
  })

  it('detects tool set additions', () => {
    const fp1 = computeFingerprint('system', SAMPLE_TOOLS.slice(0, 2))
    const fp2 = computeFingerprint('system', SAMPLE_TOOLS)

    assert.notEqual(fp1.toolsSha256, fp2.toolsSha256)
    assert.notEqual(fp1.combinedSha256, fp2.combinedSha256)
  })

  it('handles empty tools', () => {
    const fp = computeFingerprint('system', undefined)
    assert.ok(fp.systemSha256.length === 64)  // SHA-256 hex is 64 chars
    assert.ok(fp.combinedSha256.length === 64)
  })

  it('handles null/undefined tools gracefully', () => {
    const fp1 = computeFingerprint('system', [])
    const fp2 = computeFingerprint('system', undefined)
    // Empty array and undefined both produce empty tools hash
    assert.equal(fp1.toolsSha256, fp2.toolsSha256)
  })

  it('includes stable volatile context in combined fingerprint', () => {
    const a = computeFingerprint('system', [], '<context><session>A</session></context>')
    const b = computeFingerprint('system', [], '<context><session>B</session></context>')
    assert.notEqual(a.combinedSha256, b.combinedSha256)
    assert.notEqual(a.stableVolatileSha256, b.stableVolatileSha256)
    assert.equal(a.systemSha256, b.systemSha256)
    assert.equal(a.toolsSha256, b.toolsSha256)
  })

  it('defaults stableVolatile to empty string when not provided', () => {
    const a = computeFingerprint('system', [])
    const b = computeFingerprint('system', [], '')
    assert.equal(a.combinedSha256, b.combinedSha256)
    assert.equal(a.stableVolatileSha256, b.stableVolatileSha256)
  })

  it('detects tool description changes', () => {
    const fp1 = computeFingerprint('system', SAMPLE_TOOLS)
    const modified = SAMPLE_TOOLS.map(tool => tool.name === 'bash'
      ? { ...tool, description: 'Run shell commands with approval rules' }
      : tool)
    const fp2 = computeFingerprint('system', modified)

    assert.notEqual(fp1.toolsSha256, fp2.toolsSha256)
    assert.notEqual(fp1.combinedSha256, fp2.combinedSha256)
  })

  it('detects tool schema changes', () => {
    const fp1 = computeFingerprint('system', SAMPLE_TOOLS)
    const modified = SAMPLE_TOOLS.map(tool => tool.name === 'read_file'
      ? {
          ...tool,
          input_schema: {
            ...tool.input_schema!,
            type: 'object' as const,
            required: ['file_path'],
          },
        }
      : tool)
    const fp2 = computeFingerprint('system', modified)

    assert.notEqual(fp1.toolsSha256, fp2.toolsSha256)
  })
})

describe('detectDrift', () => {
  const baseline = computeFingerprint('baseline system', SAMPLE_TOOLS)

  it('returns null when fingerprints match', () => {
    const current = computeFingerprint('baseline system', SAMPLE_TOOLS)
    assert.equal(detectDrift(baseline, current), null)
  })

  it('detects system-only drift', () => {
    const current = computeFingerprint('modified system', SAMPLE_TOOLS)
    const drift = detectDrift(baseline, current)

    assert.ok(drift)
    assert.equal(drift.systemChanged, true)
    assert.equal(drift.toolsChanged, false)
    assert.ok(drift.message.includes('system prompt'))
  })

  it('detects tools-only drift', () => {
    const current = computeFingerprint('baseline system', [
      ...SAMPLE_TOOLS,
      { name: 'extra_tool', description: 'x', input_schema: { type: 'object', properties: {} } },
    ])
    const drift = detectDrift(baseline, current)

    assert.ok(drift)
    assert.equal(drift.systemChanged, false)
    assert.equal(drift.toolsChanged, true)
    assert.ok(drift.message.includes('tool definitions'))
  })

  it('detects both changed simultaneously', () => {
    const current = computeFingerprint('new system', SAMPLE_TOOLS.slice(0, 1))
    const drift = detectDrift(baseline, current)

    assert.ok(drift)
    assert.equal(drift.systemChanged, true)
    assert.equal(drift.toolsChanged, true)
    assert.equal(drift.stableVolatileChanged, false)
    assert.ok(drift.message.includes('system prompt') && drift.message.includes('tool definitions'))
  })

  it('detects stable volatile drift', () => {
    const base = computeFingerprint('system', SAMPLE_TOOLS, '<session>A</session>')
    const current = computeFingerprint('system', SAMPLE_TOOLS, '<session>B</session>')
    const drift = detectDrift(base, current)

    assert.ok(drift)
    assert.equal(drift.systemChanged, false)
    assert.equal(drift.toolsChanged, false)
    assert.equal(drift.stableVolatileChanged, true)
    assert.ok(drift.message.includes('stable volatile context'))
  })
})

describe('PromptEngine fingerprint integration', () => {
  it('computes fingerprint at construction time', async () => {
    const { PromptEngine } = await import('../engine.js')

    const engine = new PromptEngine({
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx: { tools: SAMPLE_TOOLS },
      volatileCtx: { cwd: '/test' },
    })

    const fp = engine.getFingerprint()
    assert.ok(fp.systemSha256)
    assert.ok(fp.toolsSha256)
    assert.ok(fp.stableVolatileSha256)
    assert.ok(fp.combinedSha256)
    assert.equal(fp.systemSha256.length, 64)
  })

  it('checkDrift returns null when nothing changed', async () => {
    const { PromptEngine } = await import('../engine.js')

    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: SAMPLE_TOOLS },
      volatileCtx: { cwd: '/test' },
    })

    const drift = engine.checkDrift()
    assert.equal(drift, null)
  })

  it('fingerprint is stable across buildRequest calls', async () => {
    const { PromptEngine } = await import('../engine.js')

    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: SAMPLE_TOOLS },
      volatileCtx: { cwd: '/test' },
    })

    const fpBefore = engine.getFingerprint()
    engine.buildOaiRequest([{ role: 'user', content: 'hello' }])
    engine.buildOaiRequest([{ role: 'user', content: 'another message' }])
    const fpAfter = engine.getFingerprint()

    assert.equal(fpBefore.combinedSha256, fpAfter.combinedSha256)
    assert.equal(engine.checkDrift(), null)
  })
})
