/**
 * 跨 run 陈旧 todo 清单的显示契约。
 *
 * 背景：「◇ 任务 (5/5) 有时候不会更新」——同步链路本身健全（todo/plan_task
 * 工具结果即时刷新 + 120ms ticker 兜底 + 每帧直读 state.todos），真正的机制
 * 是跨 run 陈旧显示：上一轮**全部完成**的清单在新 run 期间（phase≠idle）原样
 * 复活，直到 AI 首次写入新 todo 才变化。用户看到新任务已开工、计数却停在
 * 上一轮的 5/5，观感即「不更新」。
 *
 * 契约：
 *  1. 新 run 未写 todo 前：上一轮全完成清单隐藏（任务面板 + GlanceBar 徽章）
 *  2. 本 run 写入新 todo 后：新清单正常显示
 *  3. 本 run 内推进到全完成：仍显示（完成态本身是本 run 的有效信息）
 *  4. idle + 全完成隐藏（原有行为防回归）
 *  5. 部分完成清单跨 run 仍显示（AI 大概率续写，不视为陈旧）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'
import type { TuiApp } from '../app.js'
import type { TodoItem } from '../../../tools/todo-store.js'

const mk = (id: string, content: string, status: TodoItem['status']): TodoItem => ({ id, content, status })
const allDone = (): TodoItem[] => [
  mk('1', 'task a', 'completed'),
  mk('2', 'task b', 'completed'),
  mk('3', 'task c', 'completed'),
  mk('4', 'task d', 'completed'),
  mk('5', 'task e', 'completed'),
]

/** 模拟新 run 启动并开始流式输出（phase → streaming）。
 *  submitText 的 start()（busy 置位 + todosWrittenThisRun 重置）在
 *  commitUserPrompt 的微任务后执行——与真实时序对齐，先 await 再发 delta。 */
async function startStreamingRun(app: TuiApp): Promise<void> {
  app.submitText('next question')
  await new Promise(r => setImmediate(r))
  ;(app as unknown as { handleTextDelta: (t: string) => void }).handleTextDelta('x')
}

function setup() {
  const t = makeApp({ cols: 100, rows: 40 })
  // 上一轮的 5/5 全完成清单（run 内写入后自然结束的终态）
  t.app.setTodos(allDone())
  // 模拟 run 结束回到 idle（setPhase 由 isFinal 事件驱动，测试直调同一入口）
  ;(t.app as unknown as { setPhase: (p: string) => void }).setPhase('idle')
  return t
}

const PANEL_TITLE = '◇ 任务'
// glanceDensity 默认 compact：徽章格式 `◇done/total`（full 档才是 ◐☐☒ 分态）
const BADGE_DONE5 = '◇5/5'
const BADGE_DONE1 = '◇1/1'
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

test('新 run 未写 todo 前：上一轮全完成清单隐藏（面板 + 徽章）', async () => {
  const t = setup()
  await startStreamingRun(t.app)
  // run 已启动（todosWrittenThisRun 已重置）；取下一帧流式渲染断言——
  // 避开提交 commit 阶段（重置前一瞬）的旧徽章瞬时帧。
  t.out.clear()
  ;(t.app as unknown as { handleTextDelta: (s: string) => void }).handleTextDelta('y')
  await tick(30) // writeBatcher 异步合帧
  const plain = stripAnsi(t.out.chunks.join(''))
  assert.ok(plain.length > 0, '渲染帧到达（防空洞断言）')
  assert.ok(!plain.includes(PANEL_TITLE), `陈旧面板不显示，got: ${plain.slice(-300)}`)
  assert.ok(!plain.includes(BADGE_DONE5), '陈旧徽章不显示')
})

test('本 run 写入新 todo 后：新清单正常显示', async () => {
  const t = setup()
  await startStreamingRun(t.app)
  t.out.clear()
  t.app.setTodos([mk('n1', 'new task', 'in_progress'), mk('n2', 'another', 'pending')])
  const plain = stripAnsi(t.out.chunks.join(''))
  assert.ok(plain.includes(PANEL_TITLE), '新清单面板显示')
  assert.ok(plain.includes('new task'), '新任务条目可见')
})

test('本 run 内推进到全完成：仍显示（本 run 有效信息）', async () => {
  const t = setup()
  await startStreamingRun(t.app)
  t.app.setTodos([mk('n1', 'new task', 'in_progress')])
  t.out.clear()
  t.app.setTodos([mk('n1', 'new task', 'completed')])
  const plain = stripAnsi(t.out.chunks.join(''))
  assert.ok(plain.includes(PANEL_TITLE), '本 run 的全完成清单仍显示')
  assert.ok(plain.includes(BADGE_DONE1), '本 run 的徽章仍显示')
})

test('idle + 全完成隐藏（原有行为防回归）', async () => {
  const t = makeApp({ cols: 100, rows: 40 })
  t.app.setTodos(allDone())
  const setPhase = (p: string) => (t.app as unknown as { setPhase: (q: string) => void }).setPhase(p)
  // 对照帧：streaming 期（非 idle）全完成面板显示——渲染经输入变化驱动，
  // 避开 LiveEngine「无变化短路」的空帧。
  setPhase('streaming')
  t.out.clear()
  t.app.setInput('a')
  await tick(10)
  const shown = stripAnsi(t.out.chunks.join(''))
  assert.ok(shown.includes(PANEL_TITLE), 'streaming 期全完成面板显示（对照帧）')
  // 防回归帧：idle 后同一清单隐藏
  setPhase('idle')
  t.out.clear()
  t.app.setInput('ab')
  await tick(10)
  const hidden = stripAnsi(t.out.chunks.join(''))
  assert.ok(hidden.length > 0, '渲染帧到达（防空洞断言）')
  assert.ok(!hidden.includes(PANEL_TITLE), 'idle 全完成不显示面板（原有行为）')
})

test('部分完成清单跨 run 仍显示（不视为陈旧）', async () => {
  const t = makeApp({ cols: 100, rows: 40 })
  t.app.setTodos([mk('1', 'half done', 'completed'), mk('2', 'rest', 'in_progress')])
  t.out.clear()
  await startStreamingRun(t.app)
  const plain = stripAnsi(t.out.chunks.join(''))
  assert.ok(plain.includes(PANEL_TITLE), '部分完成清单跨 run 仍显示')
})
