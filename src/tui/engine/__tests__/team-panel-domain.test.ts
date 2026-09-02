/**
 * T9 子代理 TeamPanel + GlanceBar domain 测试（D）。
 *
 * 契约：
 *  1. team_orchestrate 工具结果的编码串解码渲染为面板，而非裸编码串。
 *  2. delegate_* / team_orchestrate 不切换 GlanceBar 会话星域（天机是编排阶段
 *     标记不是会话星域，不上主面板——2026-08-29 用户实锤修正）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { encodeTeamPanelModel, type TeamPanelModel } from '../../team-panel-model.js'

class MockOut {
  columns = 100
  rows = 40
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
    cols: 100, rows: 40, modelName: 'test',
  })
  app.start()
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

const model: TeamPanelModel = {
  mode: 'max',
  currentWave: 0,
  totalWaves: 1,
  dispatched: 1,
  blocked: [],
  waves: [{ id: 'wave-1', taskIds: ['t1'], risk: 'low', reason: 'solo' }],
  tasks: [
    { id: 't1', title: 'do work', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'done', summary: 'ok' },
  ],
}

test('team_orchestrate 编码串解码渲染为面板而非裸串', () => {
  const { app, out } = makeApp()
  const encoded = encodeTeamPanelModel(model)
  app.callbacks.onToolResult('t1', 'team_orchestrate', encoded, false)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('团队编队') && plain.includes('max'), `panel rendered: ${plain.slice(0, 200)}`)
  assert.ok(!plain.includes('rivet:team-panel:v1:'), 'raw encoded string must not leak')
})

test('delegate_task 不再切换 GlanceBar 星域（天机是阶段标记不上主面板）', async () => {
  const { app, out } = makeApp()
  app.callbacks.onToolUse('d1', 'delegate_task', { objective: 'explore' })
  let plain = stripAnsi(out.chunks.join(''))
  assert.ok(!plain.includes('天机'), `no tianji on the main panel: ${plain.slice(0, 200)}`)

  // 最终回合完成 → 星域显示保持默认（天枢），全程不变
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await tick()
  plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('天枢'), `domain stays default: ${plain}`)
  assert.ok(!plain.includes('天机'), 'domain never 天机')
})
