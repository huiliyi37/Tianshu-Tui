import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { estimateBlockSize, estimateTimelineSize } from '../thread-layout.js'
import type { ConvoBlock } from '../../state/event-reducer'

function block(kind: ConvoBlock['kind']): ConvoBlock {
  return { key: 'k1', kind, text: '' } as ConvoBlock
}

describe('estimateBlockSize', () => {
  it('gives tool/result rows a compact stable estimate', () => {
    assert.equal(estimateBlockSize(block('tool')), 44)
    assert.equal(estimateBlockSize(block('result')), 44)
  })

  it('gives user/assistant messages a taller estimate', () => {
    assert.ok(estimateBlockSize(block('user')) >= 80)
    assert.ok(estimateBlockSize(block('assistant')) >= 80)
  })

  it('gives thinking blocks a smaller estimate than messages', () => {
    assert.equal(estimateBlockSize(block('thinking')), 40)
  })

  it('gives meta blocks a small estimate', () => {
    assert.equal(estimateBlockSize(block('phase')), 28)
    assert.equal(estimateBlockSize(block('turn')), 28)
  })
})

describe('estimateTimelineSize', () => {
  it('estimates a baseline for an empty timeline', () => {
    assert.equal(estimateTimelineSize([]), 44)
  })

  it('estimates per-item compact rows', () => {
    assert.equal(estimateTimelineSize([block('tool'), block('thinking'), block('result')]), 28 + 3 * 28)
  })
})
