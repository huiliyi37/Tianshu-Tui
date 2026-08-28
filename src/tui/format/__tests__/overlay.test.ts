import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { getTheme } from '../../theme.js'
import { renderPager, renderTasks, scrollWindowWithIndicators } from '../overlay.js'
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
    assert.ok(text.includes('T1 侦察代码'), '行内展示中文身份（shortLabel + 紧凑职能）')
    assert.ok(text.includes('grep seams'))
    assert.ok(text.includes('Enter:详情'))
    assert.ok(text.includes('Tab:筛选'))
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
    assert.ok(text.includes('Enter:详情'))
  })

  it('空舰队：显示空态提示', () => {
    const text = stripAnsi(renderTasks({ groups: [], filter: 'running', completedCount: 0 }, 50, 10, theme).join('\n'))
    assert.ok(text.includes('暂无运行中的子代理'))
    assert.ok(text.includes('q/Esc:关闭'))
  })

  it('completed filter：显示标题与 completed 计数', () => {
    const data: TasksData = {
      groups: [{
        parentToolId: 'tool_a',
        total: 1,
        done: 1,
        failed: 0,
        running: 0,
        workers: [{ workerId: 'wo_x', shortLabel: 'X', profile: 'patcher', status: 'completed', elapsedMs: 1200 }],
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
    // 第二个 worker 行应以 > 开头（去 ANSI 后仍是 >）
    const workerLines = text.split('\n').filter(l => /[AB] worker/.test(l))
    assert.equal(workerLines.length, 2)
    assert.ok(!workerLines[0]!.includes('>'), 'first worker not selected')
    assert.ok(workerLines[1]!.includes('>'), 'second worker selected')
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

/** objective 子行：`activity` 是「此刻在干什么」，objective 是「派他去干什么」。 */
describe('renderTasks: objective 子行', () => {
  function dataWith(workerCount: number, objective?: string): TasksData {
    return {
      groups: [{
        parentToolId: 'tool_a',
        total: workerCount,
        done: 0,
        failed: 0,
        running: workerCount,
        workers: Array.from({ length: workerCount }, (_, i) => ({
          workerId: `wo_${i}`,
          shortLabel: `T${i + 1}`,
          profile: 'code_scout',
          status: 'running' as const,
          activity: 'grep seams',
          objective,
          elapsedMs: 1000,
        })),
      }],
      filter: 'running',
      completedCount: 0,
    }
  }

  it('有 objective 时在主行下渲染缩进子行', () => {
    const text = stripAnsi(renderTasks(dataWith(1, '定位舰队行渲染函数与列宽计算'), 70, 14, theme).join('\n'))
    const lines = text.split('\n')
    const mainIdx = lines.findIndex(l => l.includes('T1 侦察代码'))
    assert.ok(mainIdx >= 0, '主行存在')
    assert.ok(lines[mainIdx + 1]!.includes('定位舰队行渲染函数'), 'objective 紧跟在主行之后')
  })

  it('无 objective 时不产生空子行', () => {
    const text = stripAnsi(renderTasks(dataWith(1), 70, 14, theme).join('\n'))
    const lines = text.split('\n')
    const mainIdx = lines.findIndex(l => l.includes('T1 侦察代码'))
    // 帧内空行仍带左右边框，比较时先剥掉。
    const innerText = lines[mainIdx + 1]!.replace(/[│┃]/g, '').trim()
    assert.equal(innerText, '', '主行之后应是空白填充行，不是缩进子行')
  })

  it('纵向装不下时整体降级：宁可不显示 objective，也不能让 worker 掉出列表', () => {
    // 1 组 + 3 worker × 2 行 = 7 行需求；height 12 → maxEntries 6，装不下。
    const text = stripAnsi(renderTasks(dataWith(3, '这是一个目标'), 70, 12, theme).join('\n'))
    assert.ok(!text.includes('这是一个目标'), 'objective 子行被整体省略')
    for (const label of ['T1 侦', 'T2 侦', 'T3 侦']) {
      assert.ok(text.includes(label), `${label} 仍在列表内`)
    }
  })

  it('纵向够用时才展开（同样 3 worker，屏幕更高）', () => {
    const text = stripAnsi(renderTasks(dataWith(3, '这是一个目标'), 70, 14, theme).join('\n'))
    assert.ok(text.includes('这是一个目标'))
  })

  it('选中光标仍落在主行，不落到 objective 子行', () => {
    const lines = renderTasks(dataWith(2, '目标文本'), 70, 16, theme, 1)
    const text = stripAnsi(lines.join('\n'))
    const rows = text.split('\n')
    const secondMain = rows.findIndex(l => l.includes('T2 侦察代码'))
    assert.ok(rows[secondMain]!.includes('>'), '光标在第二个 worker 主行')
    assert.ok(!rows[secondMain + 1]!.includes('>'), '子行不带光标')
  })

  it('CJK objective 子行仍严格等宽', () => {
    const width = 58
    const long = '在 src/tui/format/ 下定位舰队行的渲染函数与列宽计算，确认窄屏降级策略的实际实现位置'
    assertAllWidth(renderTasks(dataWith(2, long), width, 16, theme), width)
  })
})

// ── scrollWindowWithIndicators：窗口行数 + 上下截断指示行必须 ≤ budget ──────
// 回归：两趟收敛不收敛——第二轮预算缩减后指示行反而增多（1→2），
// 渲染方 push ↑/↓ 指示行后总行数超预算，底边框被 overlay-engine 截断。
// 复现场景：entries=6（全高 1），sel=3，budget=5：
//   第一轮 win=(1,6) 仅 ↑；两趟后 win=(1,5)，↑↓ 同时出现 → 6 行 > 5。
describe('scrollWindowWithIndicators 收敛性', () => {
  const winRows = (heights: number[], win: { start: number; end: number }): number =>
    heights.slice(win.start, win.end).reduce((a, b) => a + b, 0)

  it('窗口行数 + 指示行数不超过 budget（两趟不收敛回归）', () => {
    const heights = [1, 1, 1, 1, 1, 1]
    const budget = 5
    const win = scrollWindowWithIndicators(heights, 3, budget)
    const indicators = (win.start > 0 ? 1 : 0) + (win.end < heights.length ? 1 : 0)
    assert.ok(
      winRows(heights, win) + indicators <= budget,
      `窗口 ${winRows(heights, win)} 行 + 指示 ${indicators} 行 = ${winRows(heights, win) + indicators} > budget ${budget}`,
    )
    assert.ok(win.start <= 3 && 3 < win.end, '选中项必须仍在窗口内')
  })

  it('变高条目（description 折行）同样收敛——按行数而非项数判据', () => {
    // connect 列表：每项 2 行（label+description），budget=9 时旧判据
    // （项数差）误判 (8,13) 5 项=10 行可放下，实际超 1 行。
    const heights = Array.from({ length: 19 }, () => 2)
    const budget = 9
    const win = scrollWindowWithIndicators(heights, 10, budget)
    const indicators = (win.start > 0 ? 1 : 0) + (win.end < heights.length ? 1 : 0)
    assert.ok(
      winRows(heights, win) + indicators <= budget,
      `窗口 ${winRows(heights, win)} 行 + 指示 ${indicators} 行超 budget ${budget}`,
    )
    // 邻居仍可见（不贴边）：两侧各至少 1 项
    assert.ok(win.start <= 9 && 11 < win.end, `选中项 10 的邻居应可见: (${win.start},${win.end})`)
  })

  it('budget=1 且选中项两侧都有条目时不退化到不可见（宁超勿丢选中）', () => {
    const win = scrollWindowWithIndicators([1, 1, 1], 1, 1)
    assert.ok(win.start <= 1 && 1 < win.end, '选中项可见')
  })
})
