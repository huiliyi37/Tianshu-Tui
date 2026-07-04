/**
 * C3 自治刹车 TUI 可见性 — app.ts 接线防回归。
 *
 * 修复的缺陷：stop-reason 相位被 onPhaseChange 静默吞掉、onAutonomyCheckpoint
 * 在 TUI 完全没接线 → 检查点暂停时终端一片安静，用户只能盲猜发"继续"。
 *
 * 覆盖：
 *  #1 guard-forced stop-reason（max-turns / wedged-loop）→ 系统行可见
 *  #2 voluntary stop-reason → 不打系统行（完成 badge 已覆盖）
 *  #3 checkpoint source 的 stop-reason → 跳过（由检查点卡片渲染，避免重复）
 *  #4 检查点暂停（paused=true）→ 摘要卡 + continue / permission 提示
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../engine/app.js'

class MockOut {
  columns = 120; rows = 24; chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
}
class MockIn {
  isTTY = true
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(): this { return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24,
    modelName: 'test',
    contextWindow: 200_000,
  })
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function scrollbackPlain(app: TuiApp): string {
  return stripAnsi(app.getScrollbackContent())
}

test('#1 guard-forced stop-reason surfaces as a system line', () => {
  const { app } = makeApp()

  app.callbacks.onPhaseChange?.('stop-reason', {
    reason: '⏹ 达到最大轮次上限（turn=200）— 任务可能未完成',
    voluntary: false,
    source: 'max-turns',
  })

  const text = scrollbackPlain(app)
  assert.ok(text.includes('达到最大轮次上限'), `expected max-turns stop line in: ${text.slice(0, 400)}`)
})

test('#2 voluntary stop-reason stays silent (completion badge covers it)', () => {
  const { app } = makeApp()

  app.callbacks.onPhaseChange?.('stop-reason', {
    reason: '✓ 任务完成（模型主动收尾）',
    voluntary: true,
    source: 'natural-finish',
  })

  const text = scrollbackPlain(app)
  assert.ok(!text.includes('任务完成'), 'voluntary finish must not print a stop-reason system line')
})

test('#3 checkpoint stop-reason is skipped (checkpoint card renders it instead)', () => {
  const { app } = makeApp()

  app.callbacks.onPhaseChange?.('stop-reason', {
    reason: '⏸ 自治检查点（已连续执行 25 轮）— 等待确认后继续',
    voluntary: false,
    source: 'checkpoint',
  })

  const text = scrollbackPlain(app)
  assert.ok(!text.includes('自治检查点'), 'checkpoint stop-reason must not duplicate the digest card')
})

test('#4 checkpoint pause renders the digest card with resume hint', () => {
  const { app } = makeApp()

  app.callbacks.onAutonomyCheckpoint?.({
    turns: 25,
    digest: '已执行 25 轮。\n修改文件 (2)：src/a.ts, src/b.ts\nToken：输入 120.0k / 输出 8.5k',
    paused: true,
  })

  const text = scrollbackPlain(app)
  assert.ok(text.includes('自治检查点'), 'pause card header must be visible')
  assert.ok(text.includes('已执行 25 轮'), 'digest content must be visible')
  assert.ok(text.includes('src/a.ts'), 'modified files from the digest must be visible')
  assert.ok(text.includes('continue'), 'resume hint must mention continue')
  assert.ok(text.includes('/permission'), 'resume hint must mention /permission')
})
