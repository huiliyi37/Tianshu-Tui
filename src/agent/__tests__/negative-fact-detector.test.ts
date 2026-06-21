import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectNegativeFactInLossyResult, guardLossyToolResult } from '../negative-fact-detector.js'

describe('negative-fact-detector', () => {
  describe('detectNegativeFactInLossyResult', () => {
    it('returns null for lossless content (no collapse markers)', () => {
      const result = detectNegativeFactInLossyResult('[ls -la] exit=0 time=0.1s lines=42 — output complete\nfile1\nfile2')
      assert.equal(result, null)
    })

    it('returns null for collapsed content without negative claims', () => {
      const result = detectNegativeFactInLossyResult('[storm-collapsed: 5 bash calls consolidated — raw output saved, use rawPath or read_section to recover]\n  ls -la  exit=0  42 lines  (collapsed)')
      assert.equal(result, null, 'collapsed but no negative claim → no detection')
    })

    it('detects "empty" in collapsed content', () => {
      const result = detectNegativeFactInLossyResult('[storm-collapsed: 5 bash calls consolidated]\n  ls -la .rivet/sessions/  exit=0  0 lines  (collapsed)\nLast output:\n  (empty)')
      assert.ok(result, 'should detect negative fact')
      assert.ok(result!.matched.toLowerCase().includes('empty'))
      assert.ok(result!.reason.includes('lossy'))
    })

    it('detects "not found" in truncated content', () => {
      const result = detectNegativeFactInLossyResult('[ls -la] exit=0 time=0.1s lines=500\n...\n[output truncated: head 100 + tail 80 of 500 lines shown — 320 lines omitted]\nnot found: some/file.ts')
      assert.ok(result, 'should detect negative fact in truncated output')
      assert.ok(result!.matched.toLowerCase().includes('not found'))
    })

    it('detects "0 results" in tiered-summary content', () => {
      const result = detectNegativeFactInLossyResult('[tiered-summary: grep, 5 lines, 200 chars]\n0 results across 10 files')
      assert.ok(result, 'should detect in tiered summary')
      assert.ok(result!.matched.toLowerCase().includes('0 results'))
    })

    it('detects "0 files" in collapsed content', () => {
      const result = detectNegativeFactInLossyResult('[storm-collapsed: 4 bash calls consolidated]\n  find . -name pattern  exit=0  0 lines  (collapsed)\nLast output:\n  0 files found')
      assert.ok(result)
    })

    it('returns null for "no errors" in lossless content (normal output)', () => {
      const result = detectNegativeFactInLossyResult('[npm test] exit=0 time=1.5s lines=128 — output complete\nTests: 128 passed, 0 failed\nno errors')
      assert.equal(result, null, '"no errors" in lossless output is valid — no detection')
    })

    it('detects "no errors" in collapsed content', () => {
      const result = detectNegativeFactInLossyResult('[storm-collapsed: 4 npm test calls consolidated]\n  npm test  exit=0  128 lines  (collapsed)\nLast output:\n  Tests: 128 passed, 0 failed, no errors')
      assert.ok(result, '"no errors" in collapsed output must be detected')
    })

    it('detects "all passed" in collapsed content', () => {
      const result = detectNegativeFactInLossyResult('[storm-collapsed: 4 bash calls consolidated]\n all passed')
      assert.ok(result)
    })

    it('detects stdout truncated marker as lossy', () => {
      const result = detectNegativeFactInLossyResult('[stdout truncated: output exceeded 32KB (50000 bytes total), showing last 24KB]\n[ls -la] exit=0 time=0.1s lines=0\nempty')
      assert.ok(result, 'stdout truncated + empty → detection')
    })
  })

  describe('guardLossyToolResult', () => {
    it('returns original content when no detection', () => {
      const content = '[ls -la] exit=0 time=0.1s lines=42 — output complete\nfile1\nfile2'
      assert.equal(guardLossyToolResult(content), content)
    })

    it('prepends VERIFICATION_REQUIRED marker when negative fact detected', () => {
      const content = '[storm-collapsed: 5 bash calls]\n  ls -la .rivet/sessions/  exit=0  0 lines  (collapsed)\n(empty)'
      const guarded = guardLossyToolResult(content)
      assert.ok(guarded.includes('[⚠ VERIFICATION_REQUIRED]'))
      assert.ok(guarded.includes('Do NOT conclude absence/emptiness'))
      assert.ok(guarded.includes(content), 'original content must be preserved after the warning')
      assert.ok(guarded.startsWith('[⚠ VERIFICATION_REQUIRED]'))
    })

    it('does not duplicate VERIFICATION_REQUIRED if already present', () => {
      const content = '[storm-collapsed: 5 bash calls]\n(empty)'
      // First guard
      const guarded1 = guardLossyToolResult(content)
      assert.ok(guarded1.includes('[⚠ VERIFICATION_REQUIRED]'))
      // Second guard should not add another marker
      const guarded2 = guardLossyToolResult(guarded1)
      const occurrences = (guarded2.match(/\[⚠ VERIFICATION_REQUIRED\]/g) ?? []).length
      assert.equal(occurrences, 1, 'must not duplicate VERIFICATION_REQUIRED marker')
    })
  })
})
