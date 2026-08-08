/**
 * 活动带在 renderLive 里的接线契约（集成层，纯函数测试覆盖不到的部分）。
 *
 * 1. todo 不进 band —— chrome 段下方的常驻任务面板已经承载它们，band 再画一遍
 *    就是同一批待办在一屏里出现两次。
 * 2. band 按实际终端列数截断 —— 漏传 width 会恒按默认 80 算，窄终端上折行后
 *    rowsForLine 少算，欠擦的旧帧顶部被后续 commit 顶进 scrollback。
 * 3. 派发已发出但首条 worker activity 未上行的窗口期要有 pill 兜底，不留白。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'
import { displayWidth } from '../../width.js'

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const WIDE = { ambiguousAsWide: true }

interface Priv {
  state: { todos: unknown[] }
  renderLive: () => void
}

test('todo 只渲染一次——band 不重复画常驻任务面板的内容', async () => {
  const { app, out } = makeApp({ cols: 100, rows: 40 })
  await flush()
  const priv = app as unknown as Priv
  priv.state.todos = [
    { id: '1', content: '修复认证 bug', status: 'in_progress', activeForm: '正在修认证 bug' },
    { id: '2', content: '写回归测试', status: 'pending' },
  ]

  out.clear()
  priv.renderLive()
  await flush()

  const frame = stripAnsi(out.chunks.join(''))
  const active = (frame.match(/正在修认证 bug/g) ?? []).length
  const pending = (frame.match(/写回归测试/g) ?? []).length
  assert.equal(active, 1, `进行中待办应只出现一次，实得 ${active} 次`)
  assert.equal(pending, 1, `待办应只出现一次，实得 ${pending} 次`)
})

test('band 按实际终端列数截断，窄终端不溢出', async () => {
  for (const cols of [60, 80]) {
    const { app, out } = makeApp({ cols, rows: 40 })
    await flush()
    const priv = app as unknown as Priv & {
      fleet: { apply: (a: Record<string, unknown>) => void }
    }
    priv.fleet.apply({
      workOrderId: 'wo-1',
      parentToolId: 'tool-1',
      profile: 'patcher',
      authority: 'tianliang',
      status: 'running',
      objective: '审查认证模块的令牌刷新逻辑与并发安全边界并给出完整的修复建议清单',
      toolUseCount: 12,
      tokenCount: 45_000,
    })

    out.clear()
    priv.renderLive()
    await flush()

    for (const line of stripAnsi(out.chunks.join('')).split('\n')) {
      assert.ok(
        displayWidth(line, WIDE) <= cols,
        `cols=${cols} 有行超宽 ${displayWidth(line, WIDE)}: ${line}`,
      )
    }
  }
})
