/**
 * /config 设置面板的 overlay 接线测试：按键路由、S 保存、Esc 脏确认。
 *
 * 重点是编辑态的按键归属——'s' / 'q' 在文本字段里是字符而不是快捷键，路由错了
 * 会出现「打字触发保存」或「打字关面板」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { SettingsFlow, type SettingsSaveRequest, type SettingsSaveResult } from '../../settings-flow.js'
import type { SettingsDraft, SettingsEnv } from '../../settings-model.js'

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

function draft(): SettingsDraft {
  return {
    workers: {
      profiles: { 'cheap-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' } },
      routing: { code_edit: 'cheap-flash' },
      patcherTier: 'cheap',
      escalationCap: 'off',
    },
    review: { profiles: {}, skipAuto: true, mechanicalFastPath: true },
    vision: null,
    visionAutoBridge: false,
    modelVision: {},
    basics: { toolPreset: 'minimal', approval: 'auto-safe', checkpointEveryTurns: 0, defaultDomain: 'qiming', defaultModel: '' },
    net: { mirrorsEnabled: false, mirrorsPreset: 'default', proxy: '', noProxy: '', searchBackends: 'bing', jinaBaseUrl: 'https://r.jina.ai' },
  }
}

const env: SettingsEnv = {
  models: [{ provider: 'deepseek', id: 'deepseek-v4-flash', supportsVision: false }],
  domains: [{ key: 'auto', name: 'Auto' }, { key: 'qiming', name: '启明' }],
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
  app.registerOverlays({})
  const requests: SettingsSaveRequest[] = []
  const save = (request: SettingsSaveRequest): SettingsSaveResult => {
    requests.push(request)
    return { saved: request.blocks, errors: [] }
  }
  const flow = new SettingsFlow(draft(), env)
  return { app, out, flow, save, requests }
}

function key(app: TuiApp, k: { name: string; char?: string; shift?: boolean; ctrl?: boolean }): boolean {
  return (app as unknown as { handleOverlayKey: (k: unknown) => boolean }).handleOverlayKey({ char: '', ...k })
}

function currentView(app: TuiApp) {
  return app.getSettingsOverlayData()
}

test('/config 打开 settings overlay', () => {
  const { app, flow, save } = makeApp()
  app.startSettings(flow, save)
  assert.equal(app.activeOverlayId(), 'settings')
  assert.equal(currentView(app).categories.length, 5)
})

test('Tab 在分类栏与字段区之间切焦点', () => {
  const { app, flow, save } = makeApp()
  app.startSettings(flow, save)
  assert.equal(currentView(app).focus, 'categories')
  key(app, { name: 'tab' })
  assert.equal(currentView(app).focus, 'fields')
  key(app, { name: 'tab', shift: true })
  assert.equal(currentView(app).focus, 'categories')
})

test('S 触发保存，落盘通道只收到脏块', () => {
  const { app, flow, save, requests } = makeApp()
  app.startSettings(flow, save)
  // 审查子代理 → skipAuto 切换
  key(app, { name: 'down' })
  key(app, { name: 'tab' })
  for (let i = 0; i < 20; i++) {
    if (currentView(app).fields[currentView(app).fieldIndex]?.id === 'review.skipAuto') break
    key(app, { name: 'down' })
  }
  assert.equal(currentView(app).fields[currentView(app).fieldIndex]?.id, 'review.skipAuto')
  key(app, { name: 'return' })
  assert.deepEqual(currentView(app).dirtyBlocks, ['review'])

  key(app, { name: 's', char: 's' })
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]!.blocks, ['review'])
  assert.deepEqual(currentView(app).dirtyBlocks, [])
  assert.match(currentView(app).status ?? '', /已保存/)
})

test("编辑文本字段时 's' 是字符而不是保存快捷键", () => {
  const { app, flow, save, requests } = makeApp()
  app.startSettings(flow, save)
  // 网络与镜像 → 代理地址
  for (let i = 0; i < 4; i++) key(app, { name: 'down' })
  key(app, { name: 'tab' })
  for (let i = 0; i < 10; i++) {
    if (currentView(app).fields[currentView(app).fieldIndex]?.id === 'network.proxy') break
    key(app, { name: 'down' })
  }
  key(app, { name: 'return' })
  assert.equal(currentView(app).mode, 'editor')

  for (const ch of 'socks5://x') key(app, { name: ch, char: ch })
  assert.equal(requests.length, 0, '编辑态不该触发保存')
  assert.equal(currentView(app).editor?.buffer, 'socks5://x')

  key(app, { name: 'u', char: 'u', ctrl: true })
  assert.equal(currentView(app).editor?.buffer, '')
})

test('Esc 有未保存改动时先确认，再按 Enter 才关闭', () => {
  const { app, flow, save } = makeApp()
  app.startSettings(flow, save)
  key(app, { name: 'down' })
  key(app, { name: 'tab' })
  for (let i = 0; i < 12; i++) {
    if (currentView(app).fields[currentView(app).fieldIndex]?.id === 'review.skipAuto') break
    key(app, { name: 'down' })
  }
  key(app, { name: 'return' })

  key(app, { name: 'escape' })
  assert.equal(app.activeOverlayId(), 'settings', 'Esc 不应直接丢改动')
  assert.equal(currentView(app).mode, 'confirm-discard')

  key(app, { name: 'return' })
  assert.notEqual(app.activeOverlayId(), 'settings')
})

test('无改动时 Esc 直接关闭', () => {
  const { app, flow, save } = makeApp()
  app.startSettings(flow, save)
  key(app, { name: 'escape' })
  assert.notEqual(app.activeOverlayId(), 'settings')
})
