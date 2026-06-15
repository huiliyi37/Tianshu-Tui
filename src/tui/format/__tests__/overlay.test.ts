import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { getTheme } from '../../theme.js'
import { renderPager, renderTasks } from '../overlay.js'
import type { TasksData } from '../overlay.js'

// stringWidth strips ANSI and measures CJK/emoji as 2 cells — exactly the
// terminal's view. Every rendered overlay line must occupy precisely `width`
// columns so the right border ┃ lands flush. Before the string-width fix,
// padLine/title/footer used `.length`, under-padding any wide-char line.
const theme = getTheme(0)

function assertAllWidth(lines: string[], width: number): void {
  for (const line of lines) {
    assert.equal(
      stringWidth(line),
      width,
      `expected width ${width}, got ${stringWidth(line)} for ${JSON.stringify(line)}`,
    )
  }
}

// Scope: this validates the padLine / formatTitleBar / formatFooter
// string-width fix (the wave2 target). renderPager feeds content lines straight
// to padLine without per-column .padEnd, so it isolates exactly the helpers we
// changed. The per-column .padEnd inside renderChronicle/Starmap/Tasks still
// measures by code units — a separate column-layout concern, tracked as a
// follow-up, not part of this wave.
describe('overlay CJK/emoji width alignment (padLine / title / footer)', () => {
  it('renderPager: CJK title + CJK/emoji content lines stay exactly width wide', () => {
    const width = 40
    const lines = renderPager(
      { content: '天枢成熟度优化\n你好世界🛡\nascii line', page: 0, title: '会话编年史' },
      width,
      10,
      theme,
    )
    assertAllWidth(lines, width)
  })

  it('renderPager: pure-ASCII content is unaffected (no regression)', () => {
    const width = 32
    const lines = renderPager(
      { content: 'line one\nline two', page: 0, title: 'Plain' },
      width,
      8,
      theme,
    )
    assertAllWidth(lines, width)
  })

  it('renderPager: empty/short lines are padded to the full width', () => {
    const width = 24
    const lines = renderPager({ content: '甲\n\nz', page: 0 }, width, 8, theme)
    assertAllWidth(lines, width)
  })
})

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

describe('renderTasks: per-worker 舰队', () => {
  it('单组：组进度 + worker 行 + 活动 + 单数汇总', () => {
    const data: TasksData = {
      groups: [{
        parentToolId: 'tool_a',
        total: 3,
        done: 1,
        failed: 0,
        running: 1,
        workers: [{ shortLabel: 'T1', profile: 'code_scout', status: 'running', activity: 'grep seams', elapsedMs: 1500 }],
      }],
    }
    const text = stripAnsi(renderTasks(data, 60, 12, theme).join('\n'))
    assert.ok(text.includes('Running Agents'))
    assert.ok(text.includes('fleet'), '单组用 fleet 标题')
    assert.ok(text.includes('1/3 done'))
    assert.ok(text.includes('T1·code_scout'))
    assert.ok(text.includes('grep seams'))
    assert.ok(text.includes('1 worker running'))
  })

  it('多组：序号化组标题 + failed 计数', () => {
    const data: TasksData = {
      groups: [
        { parentToolId: 'a', total: 2, done: 0, failed: 1, running: 1, workers: [{ shortLabel: 'T1', profile: 'patcher', status: 'running', elapsedMs: 800 }] },
        { parentToolId: 'b', total: 1, done: 0, failed: 0, running: 1, workers: [{ shortLabel: 'W1', profile: 'reviewer', status: 'running', elapsedMs: 200 }] },
      ],
    }
    const text = stripAnsi(renderTasks(data, 64, 14, theme).join('\n'))
    assert.ok(text.includes('group 1'))
    assert.ok(text.includes('group 2'))
    assert.ok(text.includes('1 failed'))
    assert.ok(text.includes('2 workers running'))
  })

  it('空舰队：显示 no running workers', () => {
    const text = stripAnsi(renderTasks({ groups: [] }, 50, 10, theme).join('\n'))
    assert.ok(text.includes('no running workers'))
    assert.ok(text.includes('0 workers running'))
  })

  it('纯 ASCII 行严格等宽（padLine 对齐）', () => {
    const data: TasksData = {
      groups: [{
        parentToolId: 'tool_a',
        total: 2,
        done: 1,
        failed: 0,
        running: 1,
        workers: [{ shortLabel: 'T1', profile: 'scout', status: 'running', activity: 'reading files', elapsedMs: 1200 }],
      }],
    }
    const width = 56
    assertAllWidth(renderTasks(data, width, 12, theme), width)
  })
})
