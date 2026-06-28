import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePairedDefaultOpen, computeToolCardDefaultOpen, type PairedEntry } from '../ToolGroup.tsx'
import type { ConvoBlock } from '../../state/event-reducer'

function block(partial: Partial<ConvoBlock> & { text: string; kind: 'tool' | 'result'; role: string }): ConvoBlock {
  return {
    key: 'k1',
    timestamp: Date.now(),
    ...partial,
  } as ConvoBlock
}

describe('computeToolCardDefaultOpen', () => {
  it('opens short action results within family threshold', () => {
    const b = block({ kind: 'result', role: 'tool · bash', text: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8' })
    assert.equal(computeToolCardDefaultOpen(b), true)
  })

  it('collapses long bash results beyond run-family threshold', () => {
    const b = block({ kind: 'result', role: 'tool · bash', text: Array.from({ length: 9 }, (_, i) => `line${i + 1}`).join('\n') })
    assert.equal(computeToolCardDefaultOpen(b), false)
  })

  it('opens short write results and collapses long ones', () => {
    const short = block({ kind: 'result', role: 'tool · write_file', text: Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') })
    assert.equal(computeToolCardDefaultOpen(short), true)
    const long = block({ kind: 'result', role: 'tool · write_file', text: Array.from({ length: 21 }, (_, i) => `line${i + 1}`).join('\n') })
    assert.equal(computeToolCardDefaultOpen(long), false)
  })

  it('always opens errored results', () => {
    const b = block({ kind: 'result', role: 'tool · bash', text: Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n'), isError: true })
    assert.equal(computeToolCardDefaultOpen(b), true)
  })

  it('always collapses successful run_tests', () => {
    const b = block({ kind: 'result', role: 'tool · run_tests', text: 'ok\nok\nok' })
    assert.equal(computeToolCardDefaultOpen(b), false)
  })
})

describe('computePairedDefaultOpen', () => {
  it('opens short paired results within threshold', () => {
    const entry: PairedEntry = {
      name: 'read_file',
      result: block({ kind: 'result', role: 'tool · read_file', text: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8' }),
    }
    assert.equal(computePairedDefaultOpen(entry), true)
  })

  it('collapses long paired results beyond threshold', () => {
    const entry: PairedEntry = {
      name: 'read_file',
      result: block({ kind: 'result', role: 'tool · read_file', text: Array.from({ length: 9 }, (_, i) => `line${i + 1}`).join('\n') }),
    }
    assert.equal(computePairedDefaultOpen(entry), false)
  })

  it('always opens errored paired results', () => {
    const entry: PairedEntry = {
      name: 'bash',
      result: block({ kind: 'result', role: 'tool · bash', text: 'long\n'.repeat(50), isError: true }),
    }
    assert.equal(computePairedDefaultOpen(entry), true)
  })
})
