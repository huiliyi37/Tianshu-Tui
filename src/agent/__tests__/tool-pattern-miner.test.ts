import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolPatternMiner } from '../tool-pattern-miner.js'

describe('ToolPatternMiner', () => {
  it('extracts bigram transition probabilities', () => {
    const miner = new ToolPatternMiner()
    miner.record('grep', 'read_file')
    miner.record('grep', 'read_file')
    miner.record('grep', 'read_file')
    miner.record('grep', 'edit_file')

    const predictions = miner.predict('grep')
    assert.equal(predictions[0]!.tool, 'read_file')
    assert.equal(predictions[0]!.probability, 0.75)
  })

  it('returns empty for unknown tool', () => {
    const miner = new ToolPatternMiner()
    assert.equal(miner.predict('unknown').length, 0)
  })

  it('filters predictions below threshold', () => {
    const miner = new ToolPatternMiner()
    miner.record('grep', 'read_file')
    miner.record('grep', 'edit_file')
    miner.record('grep', 'bash')
    miner.record('grep', 'write_file')
    // Each 25%, below 0.3 threshold
    assert.equal(miner.predict('grep', 0.3).length, 0)
  })

  it('tracks likely target path', () => {
    const miner = new ToolPatternMiner()
    miner.record('grep', 'read_file', { targetPath: 'src/foo.ts' })
    miner.record('grep', 'read_file', { targetPath: 'src/foo.ts' })
    miner.record('grep', 'read_file', { targetPath: 'src/bar.ts' })

    const predictions = miner.predict('grep')
    assert.equal(predictions[0]!.likelyTarget, 'src/foo.ts')
  })

  it('exports and imports transition state', () => {
    const miner = new ToolPatternMiner()
    miner.record('grep', 'read_file', { targetPath: 'src/foo.ts' })
    miner.record('read_file', 'grep', { targetPath: 'src' })
    miner.record('grep', 'read_file', { targetPath: 'src/foo.ts' })

    const restored = new ToolPatternMiner()
    restored.importSnapshot(miner.exportSnapshot())

    const predictions = restored.predict('grep', 0)
    assert.equal(predictions[0]!.tool, 'read_file')
    assert.equal(predictions[0]!.likelyTarget, 'src/foo.ts')
  })
})
