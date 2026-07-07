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

  it('renderPager: search mode shows query and match count', () => {
    const width = 60
    const lines = renderPager(
      { content: 'alpha\nbeta\ngamma', page: 0, mode: 'search', searchQuery: 'ta', searchMatches: 2, searchCurrent: 1 },
      width,
      10,
      theme,
    )
    const text = stripAnsi(lines.join('\n'))
    assert.ok(text.includes('搜索 "ta" (1/2)'))
    assert.ok(text.includes('alpha'))
    assert.ok(text.includes('beta'))
  })

  it('renderPager: message mode shows selected message', () => {
    const width = 60
    const lines = renderPager(
      {
        content: 'alpha\nbeta\ngamma',
        page: 0,
        mode: 'message',
        selectedMessageIndex: 0,
        messages: [{
          startLine: 0,
          endLine: 1,
          role: 'assistant',
          summary: 'alpha',
          lines: ['alpha'],
          isTruncated: false,
          rawContent: 'alpha',
        }],
      },
      width,
      10,
      theme,
    )
    const text = stripAnsi(lines.join('\n'))
    assert.ok(text.includes('消息 1/1'))
    assert.ok(text.includes('alpha'))
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
        workers: [{ workerId: 'wo_team:T1', shortLabel: 'T1', profile: 'code_scout', status: 'running', activity: 'grep seams', elapsedMs: 1500 }],
      }],
      filter: 'running',
      completedCount: 0,
    }
    const text = stripAnsi(renderTasks(data, 60, 12, theme).join('\n'))
    assert.ok(text.includes('子代理任务'))
    assert.ok(text.includes('运行中'), '标题栏 filter tab 高亮运行中')
    assert.ok(text.includes('任务组'), '单组用「任务组」标题')
    assert.ok(text.includes('1/3 完成'))
    assert.ok(text.includes('T1·code_scout'))
    assert.ok(text.includes('grep seams'))
    assert.ok(text.includes('Enter 详情'))
    assert.ok(text.includes('Tab 筛选'))
  })

  it('多组：序号化组标题 + failed 计数', () => {
    const data: TasksData = {
      groups: [
        { parentToolId: 'a', total: 2, done: 0, failed: 1, running: 1, workers: [{ workerId: 'wo_a:T1', shortLabel: 'T1', profile: 'patcher', status: 'running', elapsedMs: 800 }] },
        { parentToolId: 'b', total: 1, done: 0, failed: 0, running: 1, workers: [{ workerId: 'wo_b:W1', shortLabel: 'W1', profile: 'reviewer', status: 'running', elapsedMs: 200 }] },
      ],
      filter: 'running',
      completedCount: 0,
    }
    const text = stripAnsi(renderTasks(data, 64, 14, theme).join('\n'))
    assert.ok(text.includes('批次 1'))
    assert.ok(text.includes('批次 2'))
    assert.ok(text.includes('✗1 失败'))
    assert.ok(text.includes('Enter 详情'))
  })

  it('空舰队：显示空态提示', () => {
    const text = stripAnsi(renderTasks({ groups: [], filter: 'running', completedCount: 0 }, 50, 10, theme).join('\n'))
    assert.ok(text.includes('暂无运行中的子代理'))
    assert.ok(text.includes('q/Esc 关闭'))
  })

  it('completed filter：显示标题与 completed 计数', () => {
    const data: TasksData = {
      groups: [{
        parentToolId: 'tool_a',
        total: 1,
        done: 1,
        failed: 0,
        running: 0,
        workers: [{ workerId: 'wo_x', shortLabel: 'X', profile: 'patcher', status: 'passed', elapsedMs: 1200 }],
      }],
      filter: 'completed',
      completedCount: 1,
    }
    const text = stripAnsi(renderTasks(data, 80, 12, theme).join('\n'))
    assert.ok(text.includes('已完成'), '标题栏 filter tab 高亮已完成')
    assert.ok(text.includes('1 已完成'), 'footer 显示已完成计数')
  })

  it('选中态渲染光标', () => {
    const data: TasksData = {
      groups: [{
        parentToolId: 'tool_a',
        total: 2,
        done: 1,
        failed: 0,
        running: 1,
        workers: [
          { workerId: 'wo_1', shortLabel: 'A', profile: 'scout', status: 'running', elapsedMs: 100 },
          { workerId: 'wo_2', shortLabel: 'B', profile: 'scout', status: 'running', elapsedMs: 100 },
        ],
      }],
      filter: 'running',
      completedCount: 0,
    }
    const lines = renderTasks(data, 60, 12, theme, 1)
    const text = stripAnsi(lines.join('\n'))
    // 第二个 worker 行应以 ▶ 开头（去 ANSI 后仍是 ▶）
    const workerLines = text.split('\n').filter(l => l.includes('A·') || l.includes('B·'))
    assert.equal(workerLines.length, 2)
    assert.ok(!workerLines[0]!.includes('▶'), 'first worker not selected')
    assert.ok(workerLines[1]!.includes('▶'), 'second worker selected')
  })

  it('纯 ASCII 行严格等宽（padLine 对齐）', () => {
    const data: TasksData = {
      groups: [{
        parentToolId: 'tool_a',
        total: 2,
        done: 1,
        failed: 0,
        running: 1,
        workers: [{ workerId: 'wo_1', shortLabel: 'T1', profile: 'scout', status: 'running', activity: 'reading files', elapsedMs: 1200 }],
      }],
      filter: 'running',
      completedCount: 0,
    }
    const width = 56
    assertAllWidth(renderTasks(data, width, 12, theme), width)
  })
})
