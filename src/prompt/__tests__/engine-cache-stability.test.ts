import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStableVolatileBlock, buildLatestTurnVolatileBlock, buildDynamicAppendix } from '../volatile.js'

describe('ice-mirror: cache stability', () => {
  const baseCtx = {
    cwd: '/test',
    gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts',
    rivetMd: '# Project\nTest project',
    workingSet: ['src/foo.ts'],
  }

  it('FROZEN includes git-status section', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    assert.ok(frozen.includes('<git-status>'), 'FROZEN must contain <git-status>')
    assert.ok(frozen.includes('M src/foo.ts'))
  })

  it('FROZEN does NOT include dynamic sections', () => {
    const frozen = buildStableVolatileBlock({
      ...baseCtx,
      toolHistory: [{ tool: 'read_file', target: 'x', status: 'success' as const }],
      behaviorMirror: 'test mirror',
      decisions: ['decision 1'],
    })
    assert.ok(!frozen.includes('<tool-history'))
    assert.ok(!frozen.includes('<behavior-mirror'))
    assert.ok(!frozen.includes('<decisions'))
  })

  it('FRESH equals FROZEN when dynamic fields are empty', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    const fresh = buildLatestTurnVolatileBlock(baseCtx)
    assert.equal(frozen, fresh, 'FRESH must equal FROZEN byte-for-byte when no dynamic fields')
  })

  it('FROZEN is a string prefix of FRESH when dynamic fields present', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    const fresh = buildLatestTurnVolatileBlock({
      ...baseCtx,
      toolHistory: [{ tool: 'read_file', target: 'src/foo.ts', status: 'success' as const }],
    })
    assert.ok(fresh.startsWith(frozen), 'FRESH must start with exact FROZEN bytes')
    assert.ok(fresh.length > frozen.length, 'FRESH must be longer when dynamic fields present')
  })

  it('dynamic appendix contains tool-history when provided', () => {
    const appendix = buildDynamicAppendix({
      ...baseCtx,
      toolHistory: [{ tool: 'read_file', target: 'src/foo.ts', status: 'success' as const }],
    })
    assert.ok(appendix.includes('<context-update>'))
    assert.ok(appendix.includes('<tool-history'))
    assert.ok(appendix.includes('read_file'))
  })

  it('dynamic appendix is empty string when no dynamic fields', () => {
    const appendix = buildDynamicAppendix(baseCtx)
    assert.equal(appendix, '')
  })

  it('FROZEN is identical across repeated calls with same ctx', () => {
    const frozen1 = buildStableVolatileBlock(baseCtx)
    const frozen2 = buildStableVolatileBlock(baseCtx)
    assert.equal(frozen1, frozen2, 'FROZEN must be deterministic')
  })
})
