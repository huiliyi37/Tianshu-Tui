import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mintNumericId,
  sanitizeSymbol,
  buildAgentMark,
  formatMarkName,
  VOID_SYMBOL,
  VOID_GLYPHS,
} from '../void-identity.js'

test('mintNumericId uses the injected source and defaults to a 4-digit range', () => {
  assert.equal(mintNumericId(() => 7281), 7281)
  const real = mintNumericId()
  assert.ok(real >= 1000 && real <= 9999)
})

test('sanitizeSymbol caps to 2 glyphs and falls back to the void symbol', () => {
  assert.equal(sanitizeSymbol('⚘'), '⚘')
  assert.equal(sanitizeSymbol('  ✦  '), '✦')
  assert.equal(sanitizeSymbol('abcd'), 'ab')
  assert.equal(sanitizeSymbol(''), VOID_SYMBOL)
  assert.equal(sanitizeSymbol(undefined), VOID_SYMBOL)
  assert.equal(sanitizeSymbol(42), VOID_SYMBOL)
})

test('buildAgentMark uses the agent-chosen symbol (no derivation)', () => {
  const mark = buildAgentMark({ numericId: 7281, symbol: '⚘', domain: 'yaoguang' })
  assert.equal(mark.numericId, 7281)
  assert.equal(mark.symbol, '⚘')
  assert.equal(mark.domain, 'yaoguang')
  // AgentMark carries no trajectory/signature field.
  assert.equal('signature' in mark, false)
})

test('buildAgentMark mints an id when none supplied and defaults domain to empty', () => {
  const mark = buildAgentMark({ symbol: '✦', randomInt: () => 1234 })
  assert.equal(mark.numericId, 1234)
  assert.equal(mark.domain, '')
})

test('an empty chosen symbol becomes the void mark', () => {
  const mark = buildAgentMark({ symbol: '   ', randomInt: () => 1 })
  assert.equal(mark.symbol, VOID_SYMBOL)
})

test('formatMarkName renders domain·#id·symbol, omitting empty domain', () => {
  assert.equal(formatMarkName(buildAgentMark({ numericId: 7281, symbol: '⚘', domain: 'yaoguang' })), 'yaoguang·#7281·⚘')
  assert.equal(formatMarkName(buildAgentMark({ numericId: 42, symbol: '✦' })), '#42·✦')
})

test('VOID_GLYPHS is a non-empty suggestion palette', () => {
  assert.ok(VOID_GLYPHS.length > 0)
  assert.ok(VOID_GLYPHS.every(g => typeof g === 'string' && g.length > 0))
})
