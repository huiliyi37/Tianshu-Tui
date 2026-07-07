/**
 * Tests for observation-extractor noise gates (G1/G2/G3).
 *
 * 瑶光 #1: 反证测试 — 噪声片段必须被过滤，有效信号必须通过。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractObservations } from '../observation-extractor.js'

describe('observation-extractor noise gates', () => {
  // ── G1: Noise rejection ───────────────────────────────────────────────

  it('rejects backtick-wrapped code fragments', () => {
    const text = 'The function `validatePath` returns null for non-slash input'
    const obs = extractObservations(text)
    // "returns null for non-slash input" was previously captured — should now be filtered
    const hasCodeFrag = obs.some(o => o.text.includes('returns null'))
    assert.equal(hasCodeFrag, false, 'backtick-containing fragments must be filtered')
  })

  it('rejects file path references', () => {
    const text = 'loop.ts:1431 注入了 cross-session-memory block'
    const obs = extractObservations(text)
    const hasPathRef = obs.some(o => o.text.includes('loop.ts') || o.text.includes('src/'))
    assert.equal(hasPathRef, false, 'file path references must be filtered')
  })

  it('rejects meta-cognition fragments', () => {
    const text = '"to read the file first" 被当成 decision 记录。这些不是真正的项目决策'
    const obs = extractObservations(text)
    const hasMeta = obs.some(o => o.text.includes('被当成') || o.text.includes('这些不是'))
    assert.equal(hasMeta, false, 'meta-cognition fragments must be filtered')
  })

  it('rejects too-short fragments (< 4 chars)', () => {
    const text = 'The variable x is used everywhere. The word wired is here.'
    const obs = extractObservations(text)
    const hasShort = obs.some(o => o.text.length <= 3)
    assert.equal(hasShort, false, 'fragments ≤3 chars must be filtered')
  })

  it('rejects JSON attribute fragments', () => {
    const text = 'The claim has evidence: {"kind":"fact","confidence":0.9}'
    const obs = extractObservations(text)
    const hasJson = obs.some(o => o.text.includes('confidence') && o.text.includes('evidence'))
    assert.equal(hasJson, false, 'JSON-like fragments must be filtered')
  })

  // ── G2: Minimum content ────────────────────────────────────────────────

  it('rejects fragments shorter than 20 chars with fewer than 5 words', () => {
    const text = 'I decided to use tsx'
    const obs = extractObservations(text)
    // "to use tsx" is ~10 chars, 3 words — should fail G2
    const hasShortDecision = obs.some(o => o.kind === 'decision' && o.text.length < 20)
    assert.equal(hasShortDecision, false, 'short fragments must be filtered by G2')
  })

  it('accepts substantial observations', () => {
    const text = 'This project uses TypeScript strict mode with noUncheckedIndexedAccess enabled across all source files'
    const obs = extractObservations(text)
    const hasFact = obs.some(o => o.kind === 'fact' && o.text.includes('TypeScript'))
    assert.equal(hasFact, true, 'substantial observations must pass G2')
  })

  // ── Confidence calibration ─────────────────────────────────────────────

  it('constraint confidence is downgraded to 0.7', () => {
    const text = 'You must not use console.log for debugging in production code paths'
    const obs = extractObservations(text)
    const constraint = obs.find(o => o.kind === 'constraint')
    if (constraint) {
      assert.ok(constraint.confidence <= 0.7, `constraint confidence ${constraint.confidence} should be ≤0.7`)
    }
  })

  it('decision with quoted text gets confidence penalty', () => {
    const text = 'I decided "to use PostgreSQL" for the database layer'
    const obs = extractObservations(text)
    const decision = obs.find(o => o.kind === 'decision')
    if (decision) {
      // Base confidence 0.8, halved to 0.4 for quoted text
      assert.ok(decision.confidence <= 0.5, `quoted decision confidence ${decision.confidence} should be penalized`)
    }
  })

  // ── Cap ────────────────────────────────────────────────────────────────

  it('caps at 3 observations per round', () => {
    const text = `
      This project uses TypeScript for all source code.
      This project uses node:test for unit testing.
      I decided to adopt biome for linting and formatting.
      I prefer interface over type for public API types.
      The codebase never uses console.log statements in production.
    `
    const obs = extractObservations(text)
    assert.ok(obs.length <= 3, `observations ${obs.length} should be capped at 3`)
  })

  // ── Valid signals still pass ───────────────────────────────────────────

  it('extracts test framework fact', () => {
    const text = 'Project uses node:test for testing with assert/strict'
    const obs = extractObservations(text)
    const hasTest = obs.some(o => o.text.includes('node:test') || o.tags?.includes('testing'))
    assert.equal(hasTest, true, 'test framework detection must still work')
  })

  it('extracts lint tool fact', () => {
    const text = 'The project uses eslint for code quality checks'
    const obs = extractObservations(text)
    const hasLint = obs.some(o => o.tags?.includes('lint'))
    assert.equal(hasLint, true, 'lint tool detection must still work')
  })
})
