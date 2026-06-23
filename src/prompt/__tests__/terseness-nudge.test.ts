import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderTersenessNudge,
  buildDynamicAppendixParts,
  type VolatileContext,
} from '../volatile.js'

function baseCtx(extra: Partial<VolatileContext> = {}): VolatileContext {
  return { cwd: '/tmp/proj', ...extra }
}

describe('renderTersenessNudge (Phase 2B)', () => {
  it('governs prose only and protects verification rigor', () => {
    const out = renderTersenessNudge(false)
    assert.match(out, /^<output-style>/)
    assert.match(out, /OUTPUT PROSE ONLY/)
    assert.match(out, /never reduce verification/i)
    assert.doesNotMatch(out, /especially terse/)
  })

  it('escalates with a stricter clause', () => {
    const out = renderTersenessNudge(true)
    assert.match(out, /especially terse/)
  })
})

describe('buildDynamicAppendixParts terseness wiring', () => {
  it('is OFF by default — no output-style block, frozen/appendix unchanged', () => {
    const prev = process.env['RIVET_TERSE']
    try {
      delete process.env['RIVET_TERSE']
      const parts = buildDynamicAppendixParts(baseCtx())
      assert.equal(parts.find(p => p.name === 'output-style'), undefined)
    } finally {
      if (prev === undefined) delete process.env['RIVET_TERSE']
      else process.env['RIVET_TERSE'] = prev
    }
  })

  it('opt-in via ctx.tersenessEnabled adds exactly one output-style block', () => {
    const parts = buildDynamicAppendixParts(baseCtx({ tersenessEnabled: true }))
    const styleBlocks = parts.filter(p => p.name === 'output-style')
    assert.equal(styleBlocks.length, 1)
    assert.match(styleBlocks[0]!.content, /Be terse in prose/)
  })

  it('opt-in via RIVET_TERSE=1 env flag', () => {
    const prev = process.env['RIVET_TERSE']
    try {
      process.env['RIVET_TERSE'] = '1'
      const parts = buildDynamicAppendixParts(baseCtx())
      assert.equal(parts.filter(p => p.name === 'output-style').length, 1)
    } finally {
      if (prev === undefined) delete process.env['RIVET_TERSE']
      else process.env['RIVET_TERSE'] = prev
    }
  })

  it('escalation flag produces the stricter nudge', () => {
    const parts = buildDynamicAppendixParts(
      baseCtx({ tersenessEnabled: true, tersenessEscalate: true }),
    )
    const block = parts.find(p => p.name === 'output-style')
    assert.ok(block)
    assert.match(block!.content, /especially terse/)
  })
})
