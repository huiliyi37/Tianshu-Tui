import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamRenderer, findStableBoundary } from '../engine/stream-renderer.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function makeRenderer(columns = 80) {
  const commits: string[] = []
  const renderer = new StreamRenderer({
    commit: (ansi) => commits.push(ansi),
    getColumns: () => columns,
    getTheme: () => theme,
  })
  return { renderer, commits }
}

// ── findStableBoundary ─────────────────────────────────────────

test('findStableBoundary: 单个未完成段落无边界', () => {
  assert.equal(findStableBoundary('hello world'), 0)
  assert.equal(findStableBoundary('hello\nworld'), 0)
})

test('findStableBoundary: 空行后形成边界', () => {
  const text = 'para one\n\npara two grows'
  const cut = findStableBoundary(text)
  assert.equal(text.slice(0, cut), 'para one\n\n')
})

test('findStableBoundary: 取最后一个空行边界', () => {
  const text = 'a\n\nb\n\nc still going'
  const cut = findStableBoundary(text)
  assert.equal(text.slice(0, cut), 'a\n\nb\n\n')
})

test('findStableBoundary: 围栏内空行不是边界', () => {
  const text = '```ts\nconst a = 1\n\nconst b = 2\n'
  assert.equal(findStableBoundary(text), 0)
})

test('findStableBoundary: 围栏闭合即边界（无需空行）', () => {
  const text = '```ts\nconst a = 1\n```\nmore prose'
  const cut = findStableBoundary(text)
  assert.equal(text.slice(0, cut), '```ts\nconst a = 1\n```\n')
})

test('findStableBoundary: 最后一行（可能不完整）不参与判定', () => {
  // 末尾的空字符串行（text 以 \n 结尾）不会把前一行当成完整空行边界
  assert.equal(findStableBoundary('paragraph\n'), 0)
})

// ── StreamRenderer ─────────────────────────────────────────────

test('push 在稳定边界处增量 commit，尾部留在 pending', () => {
  const { renderer, commits } = makeRenderer()
  renderer.push('first paragraph\n\nsecond para grows')
  assert.equal(commits.length, 1)
  assert.match(commits[0]!, /first paragraph/)
  assert.equal(renderer.pendingText, 'second para grows')
})

test('围栏代码块未闭合时不 commit，闭合后整块 commit', () => {
  const { renderer, commits } = makeRenderer()
  renderer.push('```ts\nconst a = 1\n')
  assert.equal(commits.length, 0)
  renderer.push('const b = 2\n```\n')
  assert.equal(commits.length, 1)
  assert.match(commits[0]!, /const/)
  assert.equal(renderer.pendingText, '')
})

test('finalize commit 剩余尾部并返回是否有输出', () => {
  const { renderer, commits } = makeRenderer()
  renderer.push('only a tail without boundary')
  assert.equal(commits.length, 0)
  const had = renderer.finalize()
  assert.equal(had, true)
  assert.equal(commits.length, 1)
  assert.match(commits[0]!, /only a tail/)
  assert.equal(renderer.pendingText, '')
})

test('finalize 空内容返回 false 且不 commit', () => {
  const { renderer, commits } = makeRenderer()
  const had = renderer.finalize()
  assert.equal(had, false)
  assert.equal(commits.length, 0)
})

test('hasCommitted/hasContent 状态追踪', () => {
  const { renderer } = makeRenderer()
  assert.equal(renderer.hasContent, false)
  renderer.push('tail')
  assert.equal(renderer.hasContent, true)
  assert.equal(renderer.hasCommitted, false)
  renderer.push(' more\n\nnext')
  assert.equal(renderer.hasCommitted, true)
})

test('getLiveTailLines 限制显示行数（display-width aware）', () => {
  const { renderer } = makeRenderer(20)
  const lines = Array.from({ length: 10 }, (_, i) => `line number ${i}`).join('\n')
  renderer.push(lines)
  const tail = renderer.getLiveTailLines(3)
  assert.ok(tail.length <= 3)
  assert.match(tail[tail.length - 1]!, /line number 9/)
})

test('getLiveTailLines: CJK 宽字符按显示宽度截断', () => {
  const { renderer } = makeRenderer(10)
  // 一行 20 个全角字符 = 40 显示列 → 10 列宽下占 4 显示行
  renderer.push('中'.repeat(20))
  const tail = renderer.getLiveTailLines(2)
  // 2 显示行 = 最多 20 显示列 = 10 个全角字符（容许省略标记占位）
  const joined = tail.join('')
  const cjkCount = (joined.match(/中/g) ?? []).length
  assert.ok(cjkCount <= 10, `expected <= 10 CJK chars, got ${cjkCount}`)
})

test('reset 丢弃 pending 与 committed 状态', () => {
  const { renderer, commits } = makeRenderer()
  renderer.push('a\n\nb tail')
  assert.equal(commits.length, 1)
  renderer.reset()
  assert.equal(renderer.pendingText, '')
  assert.equal(renderer.hasContent, false)
  assert.equal(renderer.finalize(), false)
})

test('多次 push 跨边界累积 commit 顺序正确', () => {
  const { renderer, commits } = makeRenderer()
  renderer.push('alpha para')
  renderer.push(' continues\n\nbeta')
  renderer.push(' para\n\ngamma tail')
  renderer.finalize()
  assert.equal(commits.length, 3)
  assert.match(commits[0]!, /alpha para continues/)
  assert.match(commits[1]!, /beta para/)
  assert.match(commits[2]!, /gamma tail/)
})
