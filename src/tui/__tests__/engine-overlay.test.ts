import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OverlayEngine, type OverlayRenderer } from '../engine/overlay-engine.js'

function mockStdout(): { stdout: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = []
  const stdout = {
    write: (chunk: string) => { writes.push(chunk); return true },
    columns: 80,
    rows: 24,
  } as unknown as NodeJS.WriteStream
  return { stdout, writes }
}

function mockRenderer(lines: string[]): OverlayRenderer {
  return {
    render: (_width: number, _height: number) => lines,
  }
}

function mutableRenderer(ref: { lines: string[] }): OverlayRenderer {
  return {
    render: (_width: number, _height: number) => ref.lines.slice(),
  }
}

describe('OverlayEngine', () => {
  it('activate enters alt screen and renders overlay', () => {
    const { stdout, writes } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 24 }),
    })
    engine.register('pager', mockRenderer(['Pager line 1', 'Pager line 2']))

    engine.activate('pager')

    const output = writes.join('')
    assert.ok(output.includes('\x1B[?1049h'), 'enters alt screen')
    assert.ok(output.includes('\x1B[?25l'), 'hides cursor')
    assert.ok(output.includes('Pager line 1'))
    assert.ok(output.includes('Pager line 2'))
  })

  it('deactivate exits alt screen and restores main screen', () => {
    const { stdout, writes } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 24 }),
    })
    engine.register('pager', mockRenderer(['Pager']))

    engine.activate('pager')
    writes.length = 0

    engine.deactivate()

    const output = writes.join('')
    assert.ok(output.includes('\x1B[?25h'), 'shows cursor')
    assert.ok(output.includes('\x1B[?1049l'), 'exits alt screen')
  })

  it('activate returns false for unknown overlay', () => {
    const { stdout } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 24 }),
    })
    assert.equal(engine.activate('nonexistent'), false)
  })

  it('activating a new overlay deactivates the current one', () => {
    const { stdout, writes } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 24 }),
    })
    engine.register('starmap', mockRenderer(['Star 1']))
    engine.register('pager', mockRenderer(['Pager 1']))

    engine.activate('starmap')
    writes.length = 0

    engine.activate('pager')
    const output = writes.join('')
    // 应该先退出 alt screen 再进入
    assert.ok(output.includes('\x1B[?1049l'), 'exits old alt screen')
    assert.ok(output.includes('\x1B[?1049h'), 'enters new alt screen')
  })

  it('isActive reflects current state', () => {
    const { stdout } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 24 }),
    })
    assert.equal(engine.isActive(), false)

    engine.register('pager', mockRenderer(['Pager']))
    engine.activate('pager')
    assert.equal(engine.isActive(), true)
    assert.equal(engine.activeId(), 'pager')

    engine.deactivate()
    assert.equal(engine.isActive(), false)
  })

  it('renders full screen with erase for unused rows', () => {
    const { stdout, writes } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 5 }),
    })
    engine.register('small', mockRenderer(['only two lines']))

    engine.activate('small')

    const output = writes.join('')
    // 应该有 5 个 ERASE_LINE（每个 row 一个）
    const eraseCount = (output.match(/\x1B\[2K/g) ?? []).length
    assert.equal(eraseCount, 5)
  })

  it('wraps each frame in CSI 2026 sync output', () => {
    const { stdout, writes } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 5 }),
    })
    engine.register('pager', mockRenderer(['line 1']))

    engine.activate('pager')

    const output = writes.join('')
    assert.ok(output.includes('\x1B[?2026h'), 'frame begins with BEGIN_SYNC')
    assert.ok(output.includes('\x1B[?2026l'), 'frame ends with END_SYNC')
    // BEGIN_SYNC 应出现在 END_SYNC 之前
    assert.ok(
      output.indexOf('\x1B[?2026h') < output.indexOf('\x1B[?2026l'),
      'BEGIN before END',
    )
  })

  it('rerender only rewrites changed rows (line diff)', () => {
    const ref = { lines: ['alpha', 'bravo', 'charlie'] }
    const { stdout, writes } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 5 }),
    })
    engine.register('pager', mutableRenderer(ref))

    engine.activate('pager')
    writes.length = 0

    // 只改第 2 行（index 1）
    ref.lines = ['alpha', 'BRAVO', 'charlie']
    engine.rerender()

    const output = writes.join('')
    // 只重写一行 → 仅 1 个 ERASE_LINE（全量会是 5 个）
    const eraseCount = (output.match(/\x1B\[2K/g) ?? []).length
    assert.equal(eraseCount, 1, 'only the changed row is erased/rewritten')
    // 绝对定位到第 2 行（cursorTo(2,1)）
    assert.ok(output.includes('\x1B[2;1H'), 'positions cursor at changed row')
    assert.ok(output.includes('BRAVO'), 'writes new content')
    assert.ok(!output.includes('alpha'), 'unchanged rows are skipped')
    // 仍被同步包裹
    assert.ok(output.includes('\x1B[?2026h') && output.includes('\x1B[?2026l'))
  })

  it('rerender with identical content writes nothing (no-op short circuit)', () => {
    const ref = { lines: ['same', 'content'] }
    const { stdout, writes } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 5 }),
    })
    engine.register('pager', mutableRenderer(ref))

    engine.activate('pager')
    writes.length = 0

    engine.rerender()

    assert.equal(writes.join(''), '', 'no writes when nothing changed')
  })

  it('resize triggers a full redraw', () => {
    const ref = { lines: ['a', 'b', 'c'] }
    let size = { cols: 80, rows: 5 }
    const { stdout, writes } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => size,
    })
    engine.register('pager', mutableRenderer(ref))

    engine.activate('pager')
    writes.length = 0

    size = { cols: 100, rows: 8 }
    engine.rerender()

    const output = writes.join('')
    // 全量重绘：新的 rows=8 → 8 个 ERASE_LINE
    const eraseCount = (output.match(/\x1B\[2K/g) ?? []).length
    assert.equal(eraseCount, 8, 'full redraw erases every row after resize')
  })

  it('unregister deactivates if currently active', () => {
    const { stdout, writes } = mockStdout()
    const engine = new OverlayEngine({
      stdout,
      getSize: () => ({ cols: 80, rows: 24 }),
    })
    engine.register('pager', mockRenderer(['Pager']))
    engine.activate('pager')
    writes.length = 0

    engine.unregister('pager')
    const output = writes.join('')
    assert.ok(output.includes('\x1B[?1049l'), 'exits alt screen on unregister')
    assert.equal(engine.isActive(), false)
  })
})
