import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isLossyObservation } from '../lossy-markers.js'
import { detectNegativeFactInLossyResult } from '../negative-fact-detector.js'

// W1-A4: shared lossy-marker module. Every positive case below is REAL marker
// text produced by the harness (source lines annotated in lossy-markers.ts).

describe('isLossyObservation — real marker coverage', () => {
  const realMarkers: Array<[string, string]> = [
    ['storm-collapsed', '[storm-collapsed: 12 tool results folded]'],
    ['tiered-summary', '[tiered-summary: turn 3 summarized]'],
    ['context-collapse', '[collapsed grep: 14 matches across 8 files]'],
    ['output truncated', 'line1\n[output truncated: 90000 chars total]'],
    ['stdout truncated', '[stdout truncated: output exceeded 32KB (90000 bytes total), showing last 24KB — full output at rawPath below]\nbody'],
    ['stderr truncated', '[stderr truncated: output exceeded 32KB, showing last 24KB]\nbody'],
    ['PARTIAL view', '── PARTIAL view of src/big.ts (5000 lines, 400000 chars) ──\ncontent'],
    ['budget-evicted', '[budget-evicted: 500000 chars from bash. Use read_file with offset/limit to retrieve.]'],
    ['budget-summarized', '[budget-summarized: bash cumulative 9000 tokens (limit: 8000), 400 lines]\npreview\n... [remaining 395 lines omitted — cumulative budget exceeded]'],
    ['per-call slice', 'head content\n... [truncated: 5000 tokens → 2000 token budget for bash]'],
    ['turn read budget', 'head\n... 300 lines omitted (turn read budget exceeded: 130K/120K chars). Use read_file with offset/limit for specific ranges. ...\ntail'],
    ['context pressure', 'head\n... 170 lines omitted (context pressure: 85% used). Use read_file with offset/limit for specific ranges. ...'],
    ['per-call budget', 'head\n... 80 lines omitted (per-call budget: 2000 tokens) ...\ntail'],
    ['microcompacted', '<microcompacted tool_result original_chars="90000">\npreview\n</microcompacted tool_result>'],
    ['stale-compacted', 'preview\n<stale-compacted removed_chars="50000" use_read_section_to_retrieve_full_content />\n[artifact:x1]'],
  ]

  for (const [name, sample] of realMarkers) {
    it(`detects ${name}`, () => {
      assert.equal(isLossyObservation(sample), true, `must detect: ${sample.slice(0, 60)}`)
    })
  }
})

describe('isLossyObservation — no false positives on natural language', () => {
  const benign = [
    'The log file was truncated by logrotate at midnight.',
    'Test summary: 20 passed, output complete, nothing truncated.',
    'git log --oneline shows the branch history is intact',
    'lines omitted from the report were re-added manually',
    'The file contains the word collapsed in prose form.',
    'PARTIAL match found in README (not the view marker)',
  ]
  for (const sample of benign) {
    it(`ignores: ${sample.slice(0, 40)}`, () => {
      assert.equal(isLossyObservation(sample), false, `must NOT trigger on: ${sample}`)
    })
  }
})

describe('negative-fact-detector consumes the shared list', () => {
  it('flags negative claims inside newly covered lossy paths (budget-evicted)', () => {
    const content = '[budget-evicted: 90000 chars from grep. Use read_file with offset/limit to retrieve.]\nno matches'
    const detection = detectNegativeFactInLossyResult(content)
    assert.ok(detection, 'budget-evicted + negative claim must be flagged')
  })

  it('does not flag negative claims in lossless output', () => {
    const detection = detectNegativeFactInLossyResult('grep finished: no matches')
    assert.equal(detection, null)
  })
})
