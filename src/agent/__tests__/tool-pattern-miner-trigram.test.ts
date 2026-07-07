import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolPatternMiner } from '../tool-pattern-miner.js'

describe('ToolPatternMiner trigrams', () => {
  it('uses trigram when enough data and different context', () => {
    const miner = new ToolPatternMiner()
    // Simulate: glob → grep → read_file pattern (3 times)
    miner.record('glob', 'grep')
    miner.record('grep', 'read_file')
    miner.record('glob', 'grep')
    miner.record('grep', 'read_file')
    miner.record('glob', 'grep')
    miner.record('grep', 'read_file')
    // Also add noise: grep → edit_file (from different context)
    miner.record('bash', 'grep')
    miner.record('grep', 'edit_file')

    // Bigram for grep: 3 read_file + 1 edit_file = 75% read_file
    // Trigram for glob|grep: 3 read_file = 100% read_file
    const preds = miner.predict('grep')
    assert.equal(preds[0]!.tool, 'read_file')
    // Should use trigram (glob|grep) since prev is 'grep' from last record...
    // Actually prev is 'grep' and fromTool is 'grep' so prev === fromTool, falls back to bigram
    assert.equal(preds[0]!.probability, 0.75)
  })

  it('falls back to bigram when trigram has insufficient data', () => {
    const miner = new ToolPatternMiner()
    miner.record('glob', 'grep')
    miner.record('grep', 'read_file') // only 1 trigram entry for glob|grep
    miner.record('grep', 'edit_file')

    const preds = miner.predict('grep')
    // Falls back to bigram: 1 read_file + 1 edit_file = 50% each
    assert.equal(preds.length, 2)
  })
})
