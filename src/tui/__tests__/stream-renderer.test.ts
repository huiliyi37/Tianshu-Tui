import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamRenderer, findStableBoundary } from '../engine/stream-renderer.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function makeRenderer(columns = 80) {
  const commits: string[] = []
  const cacheEvents: boolean[] = []
  let currentColumns = columns
  let themeKey = 'theme-a'
  const renderer = new StreamRenderer({
    commit: (ansi) => commits.push(ansi),
    getColumns: () => currentColumns,
    getTheme: () => theme,
    getThemeKey: () => themeKey,
    onCacheResult: hit => cacheEvents.push(hit),
  })
  return {
    renderer,
    commits,
    cacheEvents,
    setColumns: (value: number) => { currentColumns = value },
    setThemeKey: (value: string) => { themeKey = value },
  }
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

test('getLiveTailLines: 从代码块中间开始时补 synthetic fence', () => {
  const { renderer } = makeRenderer()
  renderer.push('```ts\nconst a = 1\n')
  const tail = renderer.getLiveTailLines(5)
  assert.ok(tail[0]!.startsWith('```'), 'tail prepended with synthetic fence so prose is not boxed')
})

test('getLiveTailLines: extraTail 拼在 pending 之后（顺序）', () => {
  const { renderer } = makeRenderer(80)
  renderer.push('pending head') // 无边界 → 全部留在 pending
  const tail = renderer.getLiveTailLines(6, ' newest peek')
  const joined = tail.join('\n')
  assert.match(joined, /pending head newest peek/)
})

test('getLiveTailLines: pending 为空时仅 extraTail 也逐字可见（打字机）', () => {
  const { renderer } = makeRenderer(80)
  // 模拟 blockWriter 尚未吐块：streamRenderer.pending 为空，最新 token 在 peek()
  const tail = renderer.getLiveTailLines(6, 'typing before first block')
  assert.equal(tail.length > 0, true)
  assert.match(tail.join('\n'), /typing before first block/)
})

test('getLiveTailLines: extraTail 默认空 → 行为不变', () => {
  const { renderer } = makeRenderer(80)
  renderer.push('just pending')
  assert.deepEqual(renderer.getLiveTailLines(6), renderer.getLiveTailLines(6, ''))
})

test('getLiveTailLines: pending+extraTail 均空返回空数组', () => {
  const { renderer } = makeRenderer(80)
  assert.deepEqual(renderer.getLiveTailLines(6, ''), [])
})

test('getLiveTailLines: 截断作用于 pending+extraTail 合并文本', () => {
  const { renderer } = makeRenderer(20)
  renderer.push(Array.from({ length: 6 }, (_, i) => `pline ${i}`).join('\n'))
  const extra = '\n' + Array.from({ length: 6 }, (_, i) => `eline ${i}`).join('\n')
  const tail = renderer.getLiveTailLines(3, extra)
  assert.ok(tail.length <= 3, 'capped to maxRows over combined text')
  // 最新（extraTail 末尾）应保留
  assert.match(tail[tail.length - 1]!, /eline 5/)
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

test('stable segment cache hit preserves exact ANSI bytes and refreshes LRU', () => {
  const { renderer, commits, cacheEvents } = makeRenderer()
  renderer.push('repeat me\n\n')
  renderer.reset()
  renderer.push('repeat me\n\n')

  assert.deepEqual(cacheEvents, [false, true])
  assert.equal(commits[1], commits[0], 'cached output must be byte-identical')
})

test('stable segment cache misses after columns or explicit theme identity changes', () => {
  const { renderer, cacheEvents, setColumns, setThemeKey } = makeRenderer()
  renderer.push('same segment\n\n')
  renderer.reset()
  setColumns(100)
  renderer.push('same segment\n\n')
  renderer.reset()
  setThemeKey('theme-b')
  renderer.push('same segment\n\n')

  assert.deepEqual(cacheEvents, [false, false, false])
})

test('stable segment cache is a true LRU capped at 64 entries', () => {
  const { renderer, cacheEvents } = makeRenderer()
  renderer.push('oldest\n\n')
  renderer.reset()
  for (let i = 0; i < 63; i++) {
    renderer.push(`segment-${i}\n\n`)
    renderer.reset()
  }

  renderer.push('oldest\n\n') // hit refreshes oldest to newest
  renderer.reset()
  renderer.push('overflow\n\n') // evicts segment-0, not oldest
  renderer.reset()
  renderer.push('oldest\n\n')
  renderer.reset()
  renderer.push('segment-0\n\n')

  assert.deepEqual(cacheEvents.slice(-4), [true, false, true, false])
})

test('multibyte segments at or below 16KB UTF-8 bytes are cached', () => {
  const { renderer, cacheEvents } = makeRenderer()
  const atLimit = `${'中'.repeat(5461)}x`
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), 16 * 1024)
  renderer.push(`${atLimit}\n\n`)
  renderer.reset()
  renderer.push(`${atLimit}\n\n`)
  assert.deepEqual(cacheEvents, [false, true])
})

test('multibyte segments larger than 16KB UTF-8 bytes bypass the cache', () => {
  const { renderer, cacheEvents } = makeRenderer()
  const overLimit = '中'.repeat(5462)
  assert.ok(Buffer.byteLength(overLimit, 'utf8') > 16 * 1024)
  renderer.push(`${overLimit}\n\n`)
  renderer.reset()
  renderer.push(`${overLimit}\n\n`)
  assert.deepEqual(cacheEvents, [], 'oversized segments should avoid cache bookkeeping')
})
