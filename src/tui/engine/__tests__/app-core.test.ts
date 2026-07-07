import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatElapsedShort, truncateToWidth, looksLikeFilePath } from '../app.js'

/**
 * Safety net for the engine/app.ts decomposition (mid-tui). The 2002-line
 * TuiApp class needs a live TTY harness to construct, so this net pins the pure
 * leaf helpers slated to move into a TUI format/util module during the split —
 * if a refactor relocates them, behavior must stay byte-identical. The full
 * StreamOrchestrator/ToolGroupController/OverlayController extraction is the
 * dedicated decomposition session's job.
 */

test('formatElapsedShort renders seconds under a minute', () => {
  assert.equal(formatElapsedShort(0), '0s')
  assert.equal(formatElapsedShort(999), '0s')
  assert.equal(formatElapsedShort(1000), '1s')
  assert.equal(formatElapsedShort(59_999), '59s')
})

test('formatElapsedShort renders minutes + seconds at/above a minute', () => {
  assert.equal(formatElapsedShort(60_000), '1m0s')
  assert.equal(formatElapsedShort(61_500), '1m1s')
  assert.equal(formatElapsedShort(125_000), '2m5s')
})

test('truncateToWidth returns text unchanged when it fits', () => {
  assert.equal(truncateToWidth('hello', 5), 'hello')
  assert.equal(truncateToWidth('hi', 10), 'hi')
})

test('truncateToWidth clamps non-positive widths to empty', () => {
  assert.equal(truncateToWidth('hello', 0), '')
  assert.equal(truncateToWidth('hello', -3), '')
})

test('truncateToWidth cuts on display columns for ASCII', () => {
  assert.equal(truncateToWidth('hello world', 5), 'hello')
})

test('truncateToWidth respects wide (CJK) glyph columns, never splitting one', () => {
  // each CJK char is 2 columns; width 3 fits exactly one + stops before the next
  assert.equal(truncateToWidth('你好世界', 3), '你')
  assert.equal(truncateToWidth('你好世界', 4), '你好')
  // odd budget never emits a half-width fragment of a 2-col glyph
  assert.equal(truncateToWidth('你好世界', 5), '你好')
})

test('looksLikeFilePath distinguishes absolute paths from slash commands', () => {
  assert.equal(looksLikeFilePath('/src/main.ts'), true)
  assert.equal(looksLikeFilePath('/tmp/foo bar'), true)
  assert.equal(looksLikeFilePath('~/project/readme.md'), true)
  assert.equal(looksLikeFilePath('/'), false)
  assert.equal(looksLikeFilePath('/help'), false)
  assert.equal(looksLikeFilePath('/team'), false)
  assert.equal(looksLikeFilePath('/team max plan'), false)
  assert.equal(looksLikeFilePath('plain text'), false)
  assert.equal(looksLikeFilePath('./relative/path'), false)
  // Windows 盘符路径应被识别为文件路径，而非 slash 命令
  assert.equal(looksLikeFilePath('C:\\Users\\me\\main.ts'), true)
  assert.equal(looksLikeFilePath('D:/work/readme.md'), true)
})

test('looksLikeFilePath with isKnownCommand: Linux/WSL single-segment paths', () => {
  const isCmd = (name: string) => new Set(['help', 'exit', 'team', 'model', 'review']).has(name)
  // 单段 Linux 顶级目录 → 不是已知命令 → 视为路径
  assert.equal(looksLikeFilePath('/etc', isCmd), true)
  assert.equal(looksLikeFilePath('/mnt', isCmd), true)
  assert.equal(looksLikeFilePath('/usr', isCmd), true)
  assert.equal(looksLikeFilePath('/var', isCmd), true)
  assert.equal(looksLikeFilePath('/opt', isCmd), true)
  assert.equal(looksLikeFilePath('/home', isCmd), true)
  // 已知命令 → 不是路径
  assert.equal(looksLikeFilePath('/help', isCmd), false)
  assert.equal(looksLikeFilePath('/exit', isCmd), false)
  assert.equal(looksLikeFilePath('/team', isCmd), false)
  // 无谓词 → 回退旧行为（视为命令）
  assert.equal(looksLikeFilePath('/etc'), false)
  // 多段路径始终正确（不受谓词影响）
  assert.equal(looksLikeFilePath('/etc/passwd', isCmd), true)
  assert.equal(looksLikeFilePath('/mnt/c/Users', isCmd), true)
  // 带参数的未知命令 → 视为路径（第一个 token 不是已知命令）
  assert.equal(looksLikeFilePath('/etc hosts', isCmd), true)
})
