/**
 * 启动首帧渲染回归（真实字节回放定位）。
 *
 * Bug：main.ts 构造 TuiApp 后、清屏(`\x1B[2J`)+写欢迎屏之前，会跑一批 setter
 * （setApprovalMode/setSessionStarDomain/setInput …），其中触发 renderLive 画出一版
 * 输入框；随后 main.ts 清屏把它擦掉，但 LiveEngine 仍记着 hasRendered/lastDisplayRows。
 * 于是 start() 的首次渲染走 diff/rewrite 路径 → moveToTop(cursorUp) 到错误位置 →
 * 输入框顶进欢迎屏中段、丢掉输入行与底边框（用户报："启动后还是没有输入框"）。
 *
 * 契约：start() 首帧必须是「干净 append」——不得出现 cursorUp(`\x1B[<n>A`)。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

class MockOut {
  columns = 100
  rows = 40
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
  clear() { this.chunks = [] }
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

const CURSOR_UP = /\x1B\[\d*A/

test('start() first frame is a clean append (no stale moveToTop after pre-start render + clear)', () => {
  const out = new MockOut()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: new MockIn() as unknown as ReadStream,
    cols: 100, rows: 40, modelName: 'gpt-5.5',
  })

  // 模拟 main.ts 构造后、清屏前的 setter：现在 start() 之前不应触发 stdout 输出，
  // 避免清屏前画出一版输入框，随后 flush/清屏偏差形成顶部重影。
  app.setInput('')
  assert.equal(out.chunks.join('').length, 0, 'pre-start setter 不应渲染')

  // 模拟 main.ts：清屏 + 写欢迎屏。
  out.clear()
  out.write('\x1B[2J\x1B[H')
  out.write('WELCOME\n')

  // start() 首帧：必须干净 append，不得 cursorUp 回到已被擦掉的旧区域。
  out.clear()
  app.start()
  const startOutput = out.chunks.join('')
  assert.ok(!CURSOR_UP.test(startOutput), `start() 首帧不得含 cursorUp（stale moveToTop）: ${JSON.stringify(startOutput.slice(0, 120))}`)
  // 首帧应完整含输入框三要素（顶边框/输入行/底边框的可辨识片段）。
  assert.ok(startOutput.includes('❯'), 'start() 首帧应含输入行提示符 ❯')
  assert.ok(startOutput.includes('╭') || startOutput.includes('─'), 'start() 首帧应含顶边框')
  assert.ok(startOutput.includes('╰'), 'start() 首帧应含底边框')
})
