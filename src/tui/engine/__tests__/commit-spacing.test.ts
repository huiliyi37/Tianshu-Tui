/**
 * T9 卡片间距契约测试。
 *
 * 用户反馈：消息卡片贴得太紧（user / assistant / tool / summary 之间无留白）。
 * 契约：每个提交到 scrollback 的块以一个空行（trailing blank）结尾，
 * 使相邻块之间恰有一行间距。
 *
 * CommitEngine.write 每个块一次性 stdout.write（单 chunk），
 * 因此可用最小 mock 流捕获每个块并断言其以 "\n\n" 结尾。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80,
    rows: 24,
    modelName: 'test',
  })
  return { app, out, stdin }
}

test('tool 卡片块尾有空行分隔（trailing blank）', () => {
  const { app, out } = makeApp()
  // 用 bash（非折叠工具）走即时卡片提交路径；Read 等折叠工具会缓冲进折叠组，
  // 只在 flushToolGroup 时才落 scrollback（ToolGroupController 重构后行为）。
  app.callbacks.onToolResult('1', 'bash', 'UNIQUE_TOOL_BODY_XYZ', false)
  const chunk = out.chunks.find(c => c.includes('UNIQUE_TOOL_BODY_XYZ'))
  assert.ok(chunk, 'tool 卡片应被提交到 scrollback')
  assert.ok(chunk!.endsWith('\n\n'), 'tool 卡片块应以空行结尾（与下一块留白）')
})

test('user 消息块尾有空行分隔（trailing blank）', () => {
  const { app, out, stdin } = makeApp()
  app.setInput('USER_MSG_ABC')
  assert.ok(stdin.dataHandler, 'stdin data handler 已注册')
  stdin.dataHandler!('\r') // 模拟回车提交
  // 提交块带 ❯/▌ 用户标记（区别于 setInput 的 live 输入回显，后者用 〉）
  const chunk = out.chunks.find(c => c.includes('USER_MSG_ABC') && /[❯▌]/.test(c))
  assert.ok(chunk, 'user 消息应被提交到 scrollback')
  assert.ok(chunk!.endsWith('\n\n'), 'user 消息块应以空行结尾（与 assistant 留白）')
})

test('user 消息块整体为单次写入（便于稳定的间距契约）', () => {
  const { app, out, stdin } = makeApp()
  app.setInput('SINGLE_WRITE_CHECK')
  stdin.dataHandler!('\r')
  // 仅统计提交块（带 ❯/▌ 用户标记），不含 live 输入回显（后者用 〉）
  const matching = out.chunks.filter(c => c.includes('SINGLE_WRITE_CHECK') && /[❯▌]/.test(c))
  assert.equal(matching.length, 1, 'user 消息应作为单个 chunk 提交，而非逐行写入')
})
