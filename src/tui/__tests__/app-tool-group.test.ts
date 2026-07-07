/**
 * T9 Tool Group Buffer 集成测试 — app.ts 接线防回归。
 *
 * 覆盖 #1-#4 + G4：
 *  #1 异族打断 → flush 完整组
 *  #2 并行 id 绑定正确性
 *  #3 read+grep+read 统一组摘要
 *  #4 collapsible terminal result → pendingTools 清理
 *  G4 flush 后迟到 result → 自动开新组，不产生 orphan 单卡
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../engine/app.js'

// ── minimal mocks ──────────────────────────────────────────────

class MockOut {
  columns = 120; rows = 24; chunks: string[] = []
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
    cols: 120, rows: 24,
    modelName: 'test',
    contextWindow: 200_000,
  })
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

// ── helpers ────────────────────────────────────────────────────

function scrollbackPlain(app: TuiApp): string {
  return stripAnsi(app.getScrollbackContent())
}

/** onToolResult 必须显式传 isError=false 才是 terminal result；undefined 会被当 streaming chunk */
function tr(app: TuiApp, id: string, name: string, result: string) {
  app.callbacks.onToolResult(id, name, result, false)
}

// ── #1: 异族打断 → flush 完整组 ───────────────────────────────

test('#1 read×3 + write → write 到达时 flush 3 条 read 的组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  app.callbacks.onToolUse('r3', 'read_file', { file_path: 'c.ts' })
  tr(app, 'r1', 'read_file', 'content a')
  tr(app, 'r2', 'read_file', 'content b')
  tr(app, 'r3', 'read_file', 'content c')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 3 files'), `expected 'Read 3 files' in: ${text.slice(0, 500)}`)
  assert.ok(text.includes('a.ts'), 'should include a.ts')
  assert.ok(text.includes('b.ts'), 'should include b.ts')
  assert.ok(text.includes('c.ts'), 'should include c.ts')
})

// ── #2: 并行 id 绑定正确性 ────────────────────────────────────

test('#2 read(id=A)+read(id=B) 并行，result(B) 先到 → 按 id 正确绑定', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('id-A', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('id-B', 'read_file', { file_path: 'b.ts' })
  tr(app, 'id-B', 'read_file', 'content B')
  tr(app, 'id-A', 'read_file', 'content A')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 2 files'), '2 read files in group')
  assert.ok(text.includes('a.ts'), 'a.ts should be listed')
  assert.ok(text.includes('b.ts'), 'b.ts should be listed')
  assert.ok(text.includes('content A'), 'content A should be attached to a.ts')
  assert.ok(text.includes('content B'), 'content B should be attached to b.ts')
})

// ── #3: read+grep+read 统一组 ─────────────────────────────────

test('#3 read+grep+read → 统一摘要含 Searched 1, Read 2', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'src/foo.ts' })
  tr(app, 'r1', 'read_file', 'foo')
  app.callbacks.onToolUse('g1', 'grep', { pattern: 'TODO', path: 'src/' })
  tr(app, 'g1', 'grep', 'match1')
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'src/bar.ts' })
  tr(app, 'r2', 'read_file', 'bar')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Searched 1 pattern'), `expected 'Searched 1 pattern': ${text.slice(0, 500)}`)
  assert.ok(text.includes('Read 2 files'), `expected 'Read 2 files': ${text.slice(0, 500)}`)
})

// ── #4: collapsible terminal result → pendingTools 清理 ───────

test('#4 collapsible terminal result 后 pendingTools 不残留', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  tr(app, 'r1', 'read_file', 'content')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 1 file'), 'should be grouped, not orphan card')
})

// ── G4: flush 后迟到 result → 自动开新组 ──────────────────────

test('G4 flush 后迟到 collapsible result → 自动开新组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  tr(app, 'r1', 'read_file', 'content a')
  // r2 尚未完成，write 打断 → flush
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  // r2 迟到结果
  tr(app, 'r2', 'read_file', 'content b late')
  // 再打断 flush 新组
  app.callbacks.onToolUse('w2', 'write_file', { file_path: 'out2.ts' })
  tr(app, 'w2', 'write_file', 'ok2')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 1 file'), 'first group should have 1 read')
  assert.ok(text.includes('content a'), 'r1 content should be present')
  assert.ok(text.includes('content b late'), 'late r2 content should be present')
  const readCount = [...text.matchAll(/▶ (?:Read|Searched)/g)].length // 折叠组头 ●→▶
  assert.equal(readCount, 2, 'should have 2 groups (flush + late reopen)')
})

// ── turn 边界 flush ───────────────────────────────────────────

test('turnComplete 时 flush 残余折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  tr(app, 'r1', 'read_file', 'content')
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, 1, true)

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 1 file'), 'group should be flushed on turnComplete')
})

// ── abort 后 flush ────────────────────────────────────────────

test('abort 时 flush 残余折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  tr(app, 'r1', 'read_file', 'content a')
  tr(app, 'r2', 'read_file', 'content b')
  // abort 应在清理前 flush 组
  app.callbacks.onAbort()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 2 files'), 'group should be flushed on abort')
  assert.ok(text.includes('content a'), 'r1 content should be present')
  assert.ok(text.includes('content b'), 'r2 content should be present')
})

// ── ctrl+o 展开 lastCollapsedGroup ────────────────────────────

test('flush 后 scrollback 中折叠组渲染正确，含 ctrl+o 提示', () => {
  const { app } = makeApp()

  // read×4（超过 3 条）→ group flushed by write
  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  tr(app, 'r1', 'read_file', 'line1\nline2\nline3\nline4\nline5')
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  tr(app, 'r2', 'read_file', 'b content')
  app.callbacks.onToolUse('r3', 'read_file', { file_path: 'c.ts' })
  tr(app, 'r3', 'read_file', 'c content')
  app.callbacks.onToolUse('r4', 'read_file', { file_path: 'd.ts' })
  tr(app, 'r4', 'read_file', 'd content')
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 4 files'), 'collapsed group summary')
  // 超过 3 条 entry 时显示 ctrl+o 提示 + 紧凑路径列表
  assert.ok(text.includes('[Ctrl+O]'), 'should hint Ctrl+O for >3 entries')
  // 紧凑模式下显示文件路径（逗号分隔）
  assert.ok(text.includes('a.ts'), 'a.ts in collapsed group')
  assert.ok(text.includes('b.ts'), 'b.ts in collapsed group')
})

