import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateVoidIdentity,
  signatureOf,
  symbolForSignature,
  recognizeKin,
  toAgentMark,
  VOID_GLYPHS,
} from '../void-identity.js'
import type { RetrospectFingerprint } from '../retrospect-fingerprint.js'

function fp(over: Partial<RetrospectFingerprint> = {}): RetrospectFingerprint {
  return {
    sessionId: 's', createdAt: 0,
    rootCauseKeywords: ['cache', 'race'], recommendationKeywords: ['lock'],
    stabilityTrend: 'stable', confidenceTrend: 'stable',
    maxPressure: 0.2, toolFailureRate: 0.1, bulletIds: [],
    ...over,
  }
}

test('signatureOf is order-independent on keywords', () => {
  const a = signatureOf(fp({ rootCauseKeywords: ['cache', 'race'] }))
  const b = signatureOf(fp({ rootCauseKeywords: ['race', 'cache'] }))
  assert.equal(a, b)
})

test('same signature deterministically maps to same glyph (同气相求)', () => {
  const sig = signatureOf(fp())
  assert.equal(symbolForSignature(sig), symbolForSignature(sig))
  assert.ok(VOID_GLYPHS.includes(symbolForSignature(sig)))
})

test('generateVoidIdentity is deterministic given a fingerprint (except numericId)', () => {
  const a = generateVoidIdentity({ sessionId: 's1', fingerprint: fp(), randomInt: () => 1111 })
  const b = generateVoidIdentity({ sessionId: 's2', fingerprint: fp(), randomInt: () => 2222 })
  assert.equal(a.signature, b.signature)
  assert.equal(a.symbol, b.symbol)
  assert.notEqual(a.numericId, b.numericId)
})

test('generateVoidIdentity falls back to session-derived signature without fingerprint', () => {
  const a = generateVoidIdentity({ sessionId: 'abc', randomInt: () => 5000 })
  assert.match(a.signature, /^[0-9a-f]{12}$/)
  assert.equal(a.displayName, `#5000·${a.symbol}`)
})

test('displayName includes domain when present', () => {
  const id = generateVoidIdentity({ sessionId: 's', domain: 'yaoguang', randomInt: () => 7281 })
  assert.equal(id.displayName, `yaoguang·#7281·${id.symbol}`)
})

test('toAgentMark carries identity + domain', () => {
  const id = generateVoidIdentity({ sessionId: 's', randomInt: () => 1 })
  const mark = toAgentMark(id, 'kaiyang')
  assert.equal(mark.numericId, 1)
  assert.equal(mark.domain, 'kaiyang')
  assert.equal(mark.signature, id.signature)
})

test('recognizeKin finds the most similar fingerprint above threshold', () => {
  const current = fp({ sessionId: 'cur', rootCauseKeywords: ['cache', 'race'], recommendationKeywords: ['lock'] })
  const similar = fp({ sessionId: 'kin', rootCauseKeywords: ['cache', 'race'], recommendationKeywords: ['lock'] })
  const different = fp({ sessionId: 'other', rootCauseKeywords: ['ui', 'css'], recommendationKeywords: ['flex'] })
  const match = recognizeKin(current, [different, similar], 0.5)
  assert.ok(match)
  assert.equal(match!.fingerprint.sessionId, 'kin')
  assert.ok(match!.similarity >= 0.5)
})

test('recognizeKin returns null below threshold and skips self', () => {
  const current = fp({ sessionId: 'cur', rootCauseKeywords: ['cache'] })
  const self = fp({ sessionId: 'cur', rootCauseKeywords: ['cache'] })
  const unrelated = fp({ sessionId: 'x', rootCauseKeywords: ['totally', 'different'], recommendationKeywords: ['nope'] })
  assert.equal(recognizeKin(current, [self], 0.5), null) // self skipped
  assert.equal(recognizeKin(current, [unrelated], 0.9), null)
})
