import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getToolArtifactThreshold } from '../artifact-threshold.js'

describe('getToolArtifactThreshold', () => {
  it('returns per-tool thresholds higher than default for read_file on 1M window', () => {
    const readFile = getToolArtifactThreshold('read_file', 1_000_000)
    const defaultThresh = getToolArtifactThreshold('unknown_tool', 1_000_000)
    assert.ok(readFile > defaultThresh, `read_file ${readFile} should exceed default ${defaultThresh}`)
  })

  it('returns lower threshold for grep than default', () => {
    const grep = getToolArtifactThreshold('grep', 1_000_000)
    const defaultThresh = getToolArtifactThreshold('unknown_tool', 1_000_000)
    assert.ok(grep < defaultThresh, `grep ${grep} should be below default ${defaultThresh}`)
  })

  it('returns threshold >= default for bash (same multiplier 1.0)', () => {
    const bash = getToolArtifactThreshold('bash', 1_000_000)
    const defaultThresh = getToolArtifactThreshold('unknown_tool', 1_000_000)
    assert.ok(bash >= defaultThresh, `bash ${bash} should be >= default ${defaultThresh}`)
  })

  it('returns higher threshold for run_tests than default', () => {
    const runTests = getToolArtifactThreshold('run_tests', 1_000_000)
    const defaultThresh = getToolArtifactThreshold('unknown_tool', 1_000_000)
    assert.ok(runTests > defaultThresh, `run_tests ${runTests} should exceed default ${defaultThresh}`)
  })

  it('scales with context window size', () => {
    const small = getToolArtifactThreshold('read_file', 200_000)
    const large = getToolArtifactThreshold('read_file', 1_000_000)
    assert.ok(large > small, `large window ${large} should exceed small window ${small}`)
  })

  it('falls back to legacy 800 for undefined contextWindow', () => {
    const thresh = getToolArtifactThreshold('bash', undefined)
    assert.ok(thresh > 0)
    // 800 * 1.0 = 800
    assert.ok(thresh >= 800)
  })

  it('returns default multiplier for unknown tool names', () => {
    const unknown = getToolArtifactThreshold('some_future_tool', 1_000_000)
    const explicit = getToolArtifactThreshold('web_fetch', 1_000_000)
    assert.equal(unknown, explicit) // web_fetch has multiplier 1.0 = default
  })

  it('read_file threshold is roughly 2x the base on 1M window', () => {
    const readFile = getToolArtifactThreshold('read_file', 1_000_000)
    const base = getToolArtifactThreshold('unknown_tool', 1_000_000)
    const ratio = readFile / base
    assert.ok(ratio >= 1.8 && ratio <= 2.2, `expected ~2x, got ${ratio.toFixed(1)}x (${readFile} / ${base})`)
  })

  it('grep threshold is roughly 0.67x the base on 1M window', () => {
    const grep = getToolArtifactThreshold('grep', 1_000_000)
    const base = getToolArtifactThreshold('unknown_tool', 1_000_000)
    const ratio = grep / base
    assert.ok(ratio >= 0.6 && ratio <= 0.75, `expected ~0.67x, got ${ratio.toFixed(2)}x (${grep} / ${base})`)
  })
})
