import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from '../engine/__tests__/_harness.js'

/**
 * 协同建议行（orchestration hint）端到端接线测试——输入时检测 → 渲染 →
 * Tab 采纳 → Esc 抑制。纯函数层单测见 tui/__tests__/orchestration-hint.test.ts。
 */

const TICK = () => new Promise(r => setTimeout(r, 30))
const TASK = '同时重构 auth 模块并补齐测试'

test('e2e: 输入多信号任务文本 → 输入框上方出现协同建议行', async () => {
  const t = makeApp()
  t.out.clear()
  t.stdin.dataHandler!(TASK)
  await TICK()
  const out = stripAnsi(t.out.chunks.join(''))
  assert.ok(out.includes('派蜂群'), `建议行应上屏，实得：${out.slice(-400)}`)
  assert.ok(out.includes('/team') && out.includes('/scout'), 'team 档含施工与侦察入口')
  assert.ok(!out.includes('/council'), 'team 档不推 council（不全推荐）')
})

test('e2e: 普通短输入不出建议行', async () => {
  const t = makeApp()
  t.out.clear()
  t.stdin.dataHandler!('修个 typo')
  await TICK()
  assert.ok(!stripAnsi(t.out.chunks.join('')).includes('派蜂群'))
})

test('e2e: Tab 采纳 → 输入框变为 /team + 原文本，建议行关闭', async () => {
  const t = makeApp()
  t.stdin.dataHandler!(TASK)
  await TICK()
  t.out.clear()
  t.stdin.dataHandler!('\t')
  await TICK()
  const out = stripAnsi(t.out.chunks.join(''))
  assert.ok(out.includes(`/team ${TASK}`), `Tab 后输入框应为 /team + 原文本，实得：${out.slice(-300)}`)
  assert.ok(!out.includes('派蜂群'), '采纳后建议行关闭')
  // 采纳后再输入多信号文本也不再提示（本会话关闭）
  t.out.clear()
  t.stdin.dataHandler!('x')
  await TICK()
  assert.ok(!stripAnsi(t.out.chunks.join('')).includes('派蜂群'), 'adopt 后本会话不再提示')
})

test('e2e: Esc 抑制 → 建议行消失且不计入 rewind 双击', async () => {
  const t = makeApp()
  t.stdin.dataHandler!(TASK)
  await TICK()
  t.out.clear()
  t.stdin.dataHandler!('\x1b')
  await TICK()
  assert.ok(!stripAnsi(t.out.chunks.join('')).includes('派蜂群'), 'Esc 后建议行消失')
})

test('e2e: 评审类任务 → council 档（带 token 警示），Tab 采纳组 /council 命令', async () => {
  const t = makeApp()
  t.stdin.dataHandler!('同时从架构和风险角度评审这个迁移方案并给出权衡')
  await TICK()
  const out = stripAnsi(t.out.chunks.join(''))
  assert.ok(out.includes('/council'), '评审类任务出 council 档')
  assert.ok(out.includes('token 开销大'), 'council 档带成本警示')
  t.out.clear()
  t.stdin.dataHandler!('\t')
  await TICK()
  assert.ok(stripAnsi(t.out.chunks.join('')).includes('/council 同时从架构'), 'Tab 采纳组 /council 命令')
})

test('e2e: agent 流式中（steer 输入）不触发建议行', async () => {
  const t = makeApp()
  t.app.setStreamingState(true)
  t.out.clear()
  t.stdin.dataHandler!(TASK)
  await TICK()
  assert.ok(!stripAnsi(t.out.chunks.join('')).includes('派蜂群'), 'streaming 中不提示')
  t.app.setStreamingState(false)
})

test('e2e: slash 输入不触发建议行（/team 已是命令）', async () => {
  const t = makeApp()
  t.out.clear()
  t.stdin.dataHandler!('/team 同时重构 auth 并补测试')
  await TICK()
  assert.ok(!stripAnsi(t.out.chunks.join('')).includes('派蜂群'))
})
