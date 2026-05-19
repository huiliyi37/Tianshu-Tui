import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStableVolatileBlock, buildConsolidatedBlock, buildDynamicAppendix } from '../volatile.js'

describe('three-zone layout: frozen + consolidated + working', () => {
  const baseCtx = {
    cwd: '/test',
    gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts',
    rivetMd: '# Project',
  }

  it('buildConsolidatedBlock renders habituated fields in <consolidated> tag', () => {
    const consolidated = buildConsolidatedBlock(new Map([
      ['activeDomain', '<star-domain name="tianshu" motto="test">block</star-domain>'],
      ['lessons', '<historical-lessons>\n- lesson 1\n</historical-lessons>'],
    ]))
    assert.ok(consolidated.startsWith('<consolidated>'))
    assert.ok(consolidated.endsWith('</consolidated>'))
    assert.ok(consolidated.includes('star-domain'))
    assert.ok(consolidated.includes('historical-lessons'))
  })

  it('buildConsolidatedBlock returns empty string when no habituated fields', () => {
    const consolidated = buildConsolidatedBlock(new Map())
    assert.equal(consolidated, '')
  })

  it('three-zone: FROZEN is byte prefix of FROZEN+CONSOLIDATED', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    const consolidated = buildConsolidatedBlock(new Map([
      ['domain', '<star-domain name="test" motto="m">b</star-domain>'],
    ]))
    const combined = frozen + '\n' + consolidated
    assert.ok(combined.startsWith(frozen))
  })

  it('three-zone: FROZEN+CONSOLIDATED is byte prefix of full output', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    const consolidated = buildConsolidatedBlock(new Map([
      ['domain', '<star-domain name="test" motto="m">b</star-domain>'],
    ]))
    const dynamic = buildDynamicAppendix({
      ...baseCtx,
      toolHistory: [{ tool: 'read_file', target: 'x', status: 'success' as const }],
    })
    const full = frozen + '\n' + consolidated + '\n' + dynamic
    assert.ok(full.startsWith(frozen + '\n' + consolidated))
  })

  it('consolidated block is deterministic for same input', () => {
    const fields = new Map([['a', 'content-a'], ['b', 'content-b']])
    assert.equal(buildConsolidatedBlock(fields), buildConsolidatedBlock(fields))
  })

  it('consolidated block sorts fields by key', () => {
    const fields1 = new Map([['b', 'bb'], ['a', 'aa']])
    const fields2 = new Map([['a', 'aa'], ['b', 'bb']])
    assert.equal(buildConsolidatedBlock(fields1), buildConsolidatedBlock(fields2))
  })
})
