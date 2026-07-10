/**
 * macOS driver 纯逻辑单测（不触真实 osascript）：
 * - needsClipboardInput：非 ASCII 文本改走剪贴板粘贴（IME 安全）
 * - 感知类动作（snapshot/find/wait_for）的放宽超时
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { needsClipboardInput } from '../macos-driver.js'
import { createComputerUseTool } from '../tool.js'

test('needsClipboardInput: ASCII 走 keystroke', () => {
  assert.equal(needsClipboardInput('hello world'), false)
  assert.equal(needsClipboardInput('user@example.com 123!'), false)
  assert.equal(needsClipboardInput('line1\nline2\ttab'), false)
  assert.equal(needsClipboardInput(''), false)
})

test('needsClipboardInput: CJK/emoji/重音走剪贴板', () => {
  assert.equal(needsClipboardInput('你好 测试'), true)
  assert.equal(needsClipboardInput('hello 世界'), true)
  assert.equal(needsClipboardInput('café'), true)
  assert.equal(needsClipboardInput('🎉'), true)
  assert.equal(needsClipboardInput('カタカナ'), true)
})

test('timeoutMs: 感知类动作 90s，其余 60s（含变更后反馈树采集）', () => {
  const tool = createComputerUseTool({ platform: 'darwin', proEnabled: true })
  const at = (action: string) =>
    tool.timeoutMs!({ input: { action }, toolUseId: 't', cwd: '/tmp' })
  assert.equal(at('snapshot'), 90_000)
  assert.equal(at('find'), 90_000)
  assert.equal(at('wait_for'), 90_000)
  assert.equal(at('click'), 60_000)
  assert.equal(at('type'), 60_000)
  assert.equal(at('launch_app'), 60_000)
  // 无参调用（管道防御路径）回落到默认 60s。
  assert.equal(tool.timeoutMs!(), 60_000)
})
