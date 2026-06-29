import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ToolAccumulator } from '../tool-accumulator.js'

describe('ToolAccumulator', () => {
  let acc: ToolAccumulator

  beforeEach(() => {
    acc = new ToolAccumulator()
  })

  it('returns null when fewer than 4 consecutive same-type calls (non-reader)', () => {
    acc.record({ toolName: 'bash', toolUseId: '1', content: 'a', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: '2', content: 'b', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: '3', content: 'c', turn: 1 })
    assert.equal(acc.tryCollapse('bash'), null)
  })

  it('collapses when 4+ consecutive non-reader calls detected', () => {
    for (let i = 0; i < 5; i++) {
      acc.record({ toolName: 'bash', toolUseId: `g${i}`, content: `match${i}`, turn: 1 })
    }
    const result = acc.tryCollapse('bash')
    assert.notEqual(result, null)
    assert.equal(result!.collapsedIds.length, 4)
    assert.ok(!result!.collapsedIds.includes('g4'))
    assert.ok(result!.summary.includes('storm-collapsed'))
    assert.ok(result!.summary.includes('4 bash calls'))
  })

  it('reader tools (read_file/grep/run_tests) use higher threshold (12)', () => {
    // 11 read_file calls: below threshold (12), no collapse
    for (let i = 0; i < 11; i++) {
      acc.record({ toolName: 'read_file', toolUseId: `r${i}`, content: 'x'.repeat(500), turn: 1 })
    }
    assert.equal(acc.tryCollapse('read_file'), null)

    // 12th call: hits threshold, collapses first 11
    acc.record({ toolName: 'read_file', toolUseId: 'r11', content: 'x'.repeat(500), turn: 1 })
    const result = acc.tryCollapse('read_file')
    assert.notEqual(result, null)
    assert.equal(result!.collapsedIds.length, 11)
    assert.ok(result!.summary.includes('storm-collapsed'))
    assert.ok(result!.summary.includes('read_file'))
  })

  it('run_tests uses reader threshold — 4 calls should NOT collapse', () => {
    // 4 calls with default threshold (4) would trigger collapse. With reader
    // threshold (12), they should be safe.
    for (let i = 0; i < 4; i++) {
      acc.record({ toolName: 'run_tests', toolUseId: `t${i}`, content: `✓ ${i + 1} passed`, turn: 1 })
    }
    assert.equal(acc.tryCollapse('run_tests'), null, '4 run_tests should not collapse (reader threshold=12)')
  })

  it('does not collapse different tool types', () => {
    acc.record({ toolName: 'bash', toolUseId: '1', content: 'a', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: '2', content: 'b', turn: 1 })
    acc.record({ toolName: 'read_file', toolUseId: '3', content: 'c', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: '4', content: 'd', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: '5', content: 'e', turn: 1 })
    assert.equal(acc.tryCollapse('bash'), null)
    assert.equal(acc.tryCollapse('read_file'), null)
  })

  it('breaks consecutive chain on tool type change', () => {
    acc.record({ toolName: 'bash', toolUseId: '1', content: 'a', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: '2', content: 'b', turn: 1 })
    acc.record({ toolName: 'read_file', toolUseId: '3', content: 'c', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: '4', content: 'd', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: '5', content: 'e', turn: 1 })
    assert.equal(acc.tryCollapse('bash'), null)
  })

  it('tracks consecutive count correctly', () => {
    acc.record({ toolName: 'bash', toolUseId: '1', content: 'a', turn: 1 })
    acc.record({ toolName: 'bash', toolUseId: '2', content: 'b', turn: 1 })
    assert.equal(acc.consecutiveCount('bash'), 2)
    assert.equal(acc.consecutiveCount('read_file'), 0)
  })

  it('resets correctly', () => {
    acc.record({ toolName: 'bash', toolUseId: '1', content: 'a', turn: 1 })
    acc.reset()
    assert.equal(acc.consecutiveCount('bash'), 0)
    assert.equal(acc.tryCollapse('bash'), null)
  })

  it('builds grep summary with file extraction after reader threshold', () => {
    const grepContent = (n: number) =>
      `src/a.ts:${n}:  const foo = bar\nsrc/b.ts:${n}:  const baz = qux`
    // 13 grep calls to trigger reader threshold (12 collapsed)
    for (let i = 0; i < 13; i++) {
      acc.record({ toolName: 'grep', toolUseId: `g${i}`, content: grepContent(i), turn: 1 })
    }
    const result = acc.tryCollapse('grep')!
    assert.ok(result.summary.includes('grep calls'))
    assert.ok(result.summary.includes('src/a.ts'))
    assert.ok(result.summary.includes('src/b.ts'))
  })

  it('builds read_file summary with file path extraction from headers', () => {
    for (let i = 0; i < 13; i++) {
      acc.record({ toolName: 'read_file', toolUseId: `r${i}`, content: `── src/tools/hash-edit.ts ──\n${'x'.repeat(500)}`, turn: 1 })
    }
    const result = acc.tryCollapse('read_file')!
    assert.ok(result.summary.includes('read_file calls'))
    assert.ok(result.summary.includes('src/tools/hash-edit.ts'))
    assert.ok(result.summary.includes('files: '))
  })

  it('builds bash summary with per-command metadata', () => {
    for (let i = 0; i < 5; i++) {
      acc.record({ toolName: 'bash', toolUseId: `b${i}`, content: `[cmd_${i}] exit=0 time=0.1s lines=3\noutput line 1\noutput line ${i}`, turn: 1 })
    }
    const result = acc.tryCollapse('bash')!
    assert.ok(result.summary.includes('bash calls consolidated'))
    assert.ok(result.summary.includes('collapsed'))
  })

  it('keeps a real output tail per collapsed bash call (no "no output" illusion)', () => {
    for (let i = 0; i < 5; i++) {
      acc.record({ toolName: 'bash', toolUseId: `b${i}`, content: `[cmd_${i}] exit=0 time=0.1s lines=2\nhello-${i}\nworld-${i}`, turn: 1 })
    }
    const result = acc.tryCollapse('bash')!
    // The stale calls (b0..b3) must each surface their actual stdout tail —
    // stripping it entirely is the doom-loop root cause.
    assert.ok(result.summary.includes('| world-0'), 'collapsed call output tail must be retained')
    assert.ok(result.summary.includes('| hello-0') || result.summary.includes('| world-0'))
    // Header line itself must NOT leak into the tail body.
    assert.ok(!/\|\s+\[cmd_0\]/.test(result.summary), 'header line should be skipped in tail')
  })

  it('surfaces a recovery handle when bash output embeds rawPath or artifact', () => {
    for (let i = 0; i < 5; i++) {
      acc.record({
        toolName: 'bash',
        toolUseId: `b${i}`,
        content: `[big_${i}] exit=0 time=0.1s lines=900\n...lots of output...\n[output truncated: head 100 + tail 80 of 900 lines shown — 720 lines omitted · full output: read_file /tmp/rivet-raw/abc${i}.raw — 不要重跑命令]`,
        turn: 1,
      })
    }
    const result = acc.tryCollapse('bash')!
    assert.ok(/↳ full output: read_file \/tmp\/rivet-raw\/abc\d\.raw/.test(result.summary), 'rawPath recovery handle must be exposed')
    // Meta footer lines must not be mistaken for stdout in the tail.
    assert.ok(!result.summary.includes('| [output truncated'), 'footer marker should be filtered from tail')
  })

  it('exposes artifact recovery handle for artifact-wrapped bash output', () => {
    for (let i = 0; i < 5; i++) {
      acc.record({
        toolName: 'bash',
        toolUseId: `b${i}`,
        content: `[gen_${i}] exit=0 time=2s lines=40 — output complete\nline-a\nline-b\n[artifact:art-${i}]`,
        turn: 1,
      })
    }
    const result = acc.tryCollapse('bash')!
    assert.ok(/read_section\(artifactId="art-\d"\)/.test(result.summary), 'artifact recovery handle must be exposed')
    assert.ok(!result.summary.includes('| [artifact:'), 'artifact marker should be filtered from tail')
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
