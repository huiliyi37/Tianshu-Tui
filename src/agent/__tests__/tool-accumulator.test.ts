import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ToolAccumulator } from '../tool-accumulator.js'

describe('ToolAccumulator', () => {
  let acc: ToolAccumulator

  beforeEach(() => {
    acc = new ToolAccumulator()
  })

  it('returns null when fewer than 4 consecutive same-type calls', () => {
    acc.record({ toolName: 'grep', toolUseId: '1', content: 'a', turn: 1 })
    acc.record({ toolName: 'grep', toolUseId: '2', content: 'b', turn: 1 })
    acc.record({ toolName: 'grep', toolUseId: '3', content: 'c', turn: 1 })
    assert.equal(acc.tryCollapse('grep'), null)
  })

  it('collapses when 4+ consecutive same-type calls detected', () => {
    for (let i = 0; i < 5; i++) {
      acc.record({ toolName: 'grep', toolUseId: `g${i}`, content: `match${i}`, turn: 1 })
    }
    const result = acc.tryCollapse('grep')
    assert.notEqual(result, null)
    assert.equal(result!.collapsedIds.length, 4)
    assert.ok(!result!.collapsedIds.includes('g4'))
    assert.ok(result!.summary.includes('storm-collapsed'))
    assert.ok(result!.summary.includes('4 grep calls'))
  })

  it('does not collapse different tool types', () => {
    acc.record({ toolName: 'grep', toolUseId: '1', content: 'a', turn: 1 })
    acc.record({ toolName: 'read_file', toolUseId: '2', content: 'b', turn: 1 })
    acc.record({ toolName: 'grep', toolUseId: '3', content: 'c', turn: 1 })
    acc.record({ toolName: 'read_file', toolUseId: '4', content: 'd', turn: 1 })
    assert.equal(acc.tryCollapse('read_file'), null)
    assert.equal(acc.tryCollapse('grep'), null)
  })

  it('breaks consecutive chain on tool type change', () => {
    acc.record({ toolName: 'grep', toolUseId: '1', content: 'a', turn: 1 })
    acc.record({ toolName: 'grep', toolUseId: '2', content: 'b', turn: 1 })
    acc.record({ toolName: 'read_file', toolUseId: '3', content: 'c', turn: 1 })
    acc.record({ toolName: 'grep', toolUseId: '4', content: 'd', turn: 1 })
    acc.record({ toolName: 'grep', toolUseId: '5', content: 'e', turn: 1 })
    assert.equal(acc.tryCollapse('grep'), null)
  })

  it('tracks consecutive count correctly', () => {
    acc.record({ toolName: 'grep', toolUseId: '1', content: 'a', turn: 1 })
    acc.record({ toolName: 'grep', toolUseId: '2', content: 'b', turn: 1 })
    assert.equal(acc.consecutiveCount('grep'), 2)
    assert.equal(acc.consecutiveCount('read_file'), 0)
  })

  it('resets correctly', () => {
    acc.record({ toolName: 'grep', toolUseId: '1', content: 'a', turn: 1 })
    acc.reset()
    assert.equal(acc.consecutiveCount('grep'), 0)
    assert.equal(acc.tryCollapse('grep'), null)
  })

  it('builds grep summary with file extraction', () => {
    const grepContent = (n: number) =>
      `src/a.ts:${n}:  const foo = bar\nsrc/b.ts:${n}:  const baz = qux`
    for (let i = 0; i < 5; i++) {
      acc.record({ toolName: 'grep', toolUseId: `g${i}`, content: grepContent(i), turn: 1 })
    }
    const result = acc.tryCollapse('grep')!
    assert.ok(result.summary.includes('grep calls'))
    assert.ok(result.summary.includes('src/a.ts'))
    assert.ok(result.summary.includes('src/b.ts'))
  })

  it('builds read_file summary with char count', () => {
    for (let i = 0; i < 5; i++) {
      acc.record({ toolName: 'read_file', toolUseId: `r${i}`, content: 'x'.repeat(1000), turn: 1 })
    }
    const result = acc.tryCollapse('read_file')!
    assert.ok(result.summary.includes('read_file calls'))
    assert.ok(result.summary.includes('chars collapsed'))
  })

  it('builds bash summary with last lines', () => {
    for (let i = 0; i < 5; i++) {
      acc.record({ toolName: 'bash', toolUseId: `b${i}`, content: `output line 1\noutput line ${i}`, turn: 1 })
    }
    const result = acc.tryCollapse('bash')!
    assert.ok(result.summary.includes('bash calls'))
    assert.ok(result.summary.includes('Last lines'))
  })

  it('builds generic summary for unknown tool types', () => {
    for (let i = 0; i < 5; i++) {
      acc.record({ toolName: 'custom_tool', toolUseId: `c${i}`, content: 'data', turn: 1 })
    }
    const result = acc.tryCollapse('custom_tool')!
    assert.ok(result.summary.includes('custom_tool calls'))
    assert.ok(result.summary.includes('storm-collapsed'))
  })
})
