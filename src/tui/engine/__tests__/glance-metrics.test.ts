/**
 * T9 GlanceBar 真实指标测试（B）。
 *
 * 契约（CC 对标 f9001b16：ctx% 并入 ◧token 常驻，cache ⚡ 仅 <50% 浮出）：
 *  1. 设置 metricsProvider 后，GlanceBar 用真实 ◧Xk/Yk·$cost·⚡% 渲染。
 *  2. 无 provider 时回退内部估算；cost 单次计算，不随 onTurnComplete 累计膨胀
 *     （agent 传入的 usage 已是累计快照，旧实现 += 会指数级膨胀）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

class MockOut {
  columns = 120
  rows = 24
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

test('metricsProvider 提供真实 ◧Xk/Yk·$cost·⚡%（cache 命中率常驻展示，按健康度着色）', () => {
  const { app, out } = makeApp()
  app.setMetricsProvider(() => ({
    estimatedTokens: 50_000,
    maxTokens: 200_000,
    cacheHitRate: 0.3,
    cost: 1.23,
    inputTokens: 50_000,
    outputTokens: 1_000,
    lastRealPromptTokens: 48_000,
  }))
  // setModelInfo 触发一次 renderLive
  app.setModelInfo('test', 200_000)
  const plain = stripAnsi(out.chunks.join(''))
  // estimatedTokens (50k) is the calibrated context occupancy; lastRealPromptTokens
  // is only used internally to compute the calibration ratio.
  assert.ok(plain.includes('◧50k/200k'), `Xk/Yk: ${plain}`)
  assert.ok(plain.includes('$1.23'), `cost: ${plain}`)
  assert.ok(plain.includes('⚡30%'), `cache 常驻展示: ${plain}`)
})

test('cache 健康态（≥50%）常驻展示为 dim 色，不再门控隐藏', () => {
  const { app, out } = makeApp()
  app.setMetricsProvider(() => ({
    estimatedTokens: 50_000,
    maxTokens: 200_000,
    cacheHitRate: 0.6,
    cost: 1.23,
    inputTokens: 50_000,
    outputTokens: 1_000,
    lastRealPromptTokens: 48_000,
  }))
  app.setModelInfo('test', 200_000)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('⚡60%'), `健康态也应常驻展示命中率: ${plain}`)
  assert.ok(plain.includes('◧50k/200k'), `token 显示校准后的上下文占用: ${plain}`)
})

test('无 provider 回退：cost 单次计算，多次 onTurnComplete 不膨胀', async () => {
  const { app, out } = makeApp()
  // agent 每回合传入的是「累计」usage 快照；这里固定为 1M normal-input → $1.00。
  const cumulative = {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  app.callbacks.onTurnComplete(cumulative, 1, false)
  app.callbacks.onTurnComplete(cumulative, 2, false)
  app.callbacks.onTurnComplete(cumulative, 3, false)
  await tick(30)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('$1.00'), `cost should be single-shot $1.00: ${plain}`)
  assert.ok(!plain.includes('$3.00'), 'cost must not inflate to $3.00 across turns')
})

test('getMetrics 暴露与 GlanceBar 同源的真实指标（供 SlashRouter 读 cost/maxTokens）', () => {
  const { app } = makeApp()
  // 无 provider 时为 null（SlashRouter 回退 models[0]/cost:0）
  assert.equal(app.getMetrics(), null, '无 provider 应返回 null')

  app.setMetricsProvider(() => ({
    estimatedTokens: 80_000,
    maxTokens: 200_000,
    cacheHitRate: 0.5,
    cost: 2.5,
    inputTokens: 80_000,
    outputTokens: 4_000,
    lastRealPromptTokens: 78_000,
  }))
  const m = app.getMetrics()
  assert.equal(m?.cost, 2.5, 'cost 应来自 provider，不再写死 0')
  assert.equal(m?.maxTokens, 200_000, 'maxTokens 应为当前模型窗口，不再取 models[0]')
})
