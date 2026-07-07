/**
 * T9 子代理 TeamPanel + GlanceBar domain 测试（D）。
 *
 * 契约：
 *  1. team_orchestrate 工具结果的编码串解码渲染为面板，而非裸编码串。
 *  2. delegate_* / team_orchestrate 触发 GlanceBar domain 切到天机；turn 结束复位。
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

test('delegate_task 触发 domain 切到天机，turn 结束复位', async () => {
  const { app, out } = makeApp()
  app.callbacks.onToolUse('d1', 'delegate_task', { objective: 'explore' })
  let plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('天机'), `domain switched to 天机: ${plain}`)

  out.chunks.length = 0
  // 最终回合完成 → domain 复位默认（天枢）
  app.callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await tick()
  plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('天枢'), `domain reset to default: ${plain}`)
  assert.ok(!plain.includes('天机'), 'domain no longer 天机 after idle')
})
