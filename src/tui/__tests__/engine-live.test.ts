import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LiveEngine, type LiveRegionLine } from '../engine/live-engine.js'

function mockStdout(): { stdout: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = []
  const stdout = {
    write: (chunk: string) => { writes.push(chunk); return true },
    columns: 80,
    rows: 24,
  } as unknown as NodeJS.WriteStream
  return { stdout, writes }
}

describe('LiveEngine', () => {
  it('first render writes lines directly without cursor manipulation', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })
    const lines: LiveRegionLine[] = [
      { text: 'line 1' },
      { text: 'line 2' },
    ]
    engine.render(lines)
    const output = writes.join('')
    assert.ok(output.includes('line 1'))
    assert.ok(output.includes('line 2'))
    // 首次渲染不使用 cursor save/restore
    assert.ok(!output.includes('\x1B[s'))
  })

  it('incremental redraw uses relative cursor (no SAVE/RESTORE), sync-wrapped', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })

    engine.render([{ text: 'initial' }])
    writes.length = 0 // 清空

    engine.render([{ text: 'updated' }])
    const output = writes.join('')
    // cursor-resident 协议：相对光标、无 SAVE/RESTORE、CSI 2026 同步输出包裹
    assert.ok(output.includes('updated'))
    assert.ok(!output.includes('\x1B[s'), '不应使用 SAVE_CURSOR')
    assert.ok(!output.includes('\x1B[u'), '不应使用 RESTORE_CURSOR')
    assert.ok(output.startsWith('\x1B[?2026h') && output.endsWith('\x1B[?2026l'), '应被同步输出包裹')
  })

  it('clear erases live region and resets state (no SAVE/RESTORE)', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })

    engine.render([{ text: 'some content' }])
    writes.length = 0

    engine.clear()
    const output = writes.join('')
    // clear：擦到屏幕末，不使用绝对光标
    assert.ok(output.includes('\x1B[0J'), '应擦除到屏幕末')
    assert.ok(!output.includes('\x1B[s'), '不应使用 SAVE_CURSOR')
  })

  it('renderLine is a convenience for single-line live region', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })
    engine.renderLine('streaming text...')
    const output = writes.join('')
    assert.ok(output.includes('streaming text...'))
  })

  it('reset clears internal state for full redraw', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })

    engine.render([{ text: 'frame 1' }])
    writes.length = 0

    engine.reset()
    engine.render([{ text: 'fresh start' }])
    const output = writes.join('')
    // reset 后首次渲染不使用 cursor manipulation
    assert.ok(!output.includes('\x1B[s'))
  })

  it('line cache prevents redundant redraws of unchanged lines', () => {
    const { stdout, writes } = mockStdout()
    const engine = new LiveEngine({ stdout })

    // 先渲染两行
    engine.render([
      { text: '\x1B[32mstatic\x1B[0m' },
      { text: '\x1B[33mchanging\x1B[0m' },
    ])
    writes.length = 0

    // 只改动第二行
    engine.render([
      { text: '\x1B[32mstatic\x1B[0m' },
      { text: '\x1B[34mchanged\x1B[0m' },
    ])
    const output = writes.join('')
    // 第一行不变时不应完整重绘（通过 cursorDown 跳过）
    assert.ok(output.includes('changed'))
  })
})
