import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import stringWidth from 'string-width'
import { formatWelcome } from '../format/welcome.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')

test('welcome renders CC-style header (3 lines + breathing blanks)', () => {
  const lines = formatWelcome({
    modelName: 'opus-4-8',
    cwd: '/Users/x/app/deepseek-tui/opencode-tui',
    sessionId: '878e2108abcd',
    priorMsgCount: 0,
    columns: 80,
    version: '2.15.1',
    approvalMode: 'auto-safe',
  }, theme)
  assert.ok(lines.length <= 14, `welcome should be ≤14 lines, got ${lines.length}`)
  assert.ok(lines.length >= 3, `welcome should be ≥3 lines, got ${lines.length}`)
  assert.equal(lines[0], '', 'leading blank line for breathing room')
  assert.equal(lines[lines.length - 1], '', 'trailing blank line for breathing room')
})

test('welcome contains brand, version, model, approval mode and cwd', () => {
  const lines = formatWelcome({
    modelName: 'glm-5.1',
    cwd: '/tmp/x/proj',
    sessionId: 'deadbeef1234',
    priorMsgCount: 0,
    columns: 80,
    version: '2.15.1',
    approvalMode: 'auto-safe',
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('Tianshu Code'), 'should show brand')
  assert.ok(joined.includes('v2.15.1'), 'should show version')
  assert.ok(joined.includes('glm-5.1'), 'should show model')
  assert.ok(joined.includes('auto-safe'), 'should show approval mode')
  assert.ok(joined.includes('/tmp/x/proj'), 'should show cwd')
})

test('welcome omits version/mode gracefully when not provided', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 80,
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('Tianshu Code'), 'brand still present')
  assert.ok(!joined.includes('v undefined') && !joined.includes('vnull'), 'no dangling version text')
})

test('welcome has bordered card, star logo and no shortcut matrix', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 120, rows: 40,
    version: '2.15.1',
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('┌'), 'should show border')
  assert.ok(!joined.includes('Ctrl+'), 'no shortcut matrix')
})

test('cwd under home is tildified', () => {
  const home = homedir()
  const lines = formatWelcome({
    modelName: 'm', cwd: `${home}/app/proj`, sessionId: 'abcdefgh', priorMsgCount: 0, columns: 120,
  }, theme)
  assert.ok(lines.join('\n').includes('~/app/proj'), 'home prefix collapsed to ~')
})

test('compact mode renders single line with essentials', () => {
  const lines = formatWelcome({
    modelName: 'glm-5.1',
    cwd: '/tmp/x',
    sessionId: 'deadbeef1234',
    priorMsgCount: 7,
    columns: 80,
    compact: true,
  }, theme)
  assert.equal(lines.length, 1, 'compact welcome is a single line')
  const joined = lines[0]!
  assert.ok(joined.includes('天枢'), 'should show branding')
  assert.ok(joined.includes('glm-5.1'), 'should show model')
  assert.ok(joined.includes('deadbeef'), 'should show session prefix')
  assert.ok(joined.includes('/help'), 'should hint /help')
})

test('compact mode shows prior count', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 7, columns: 80, compact: true,
  }, theme)
  assert.ok(lines.join('\n').includes('7 prior'), 'should show prior message count')
})

test('height-aware: very short terminal (<8 rows) collapses to single line', () => {
  const lines = formatWelcome({
    modelName: 'gpt-5.5', cwd: '/x', sessionId: 'abcdef012345', priorMsgCount: 0, columns: 100, rows: 6,
  }, theme)
  assert.equal(lines.length, 1, `very short terminal → single line, got ${lines.length}`)
  assert.ok(lines[0]!.includes('天枢'), 'single line still branded')
})

test('24-row terminal keeps the full header (fits easily)', () => {
  const lines = formatWelcome({
    modelName: 'deepseek-v4', cwd: '/x/proj', sessionId: 'abcdef012345', priorMsgCount: 0, columns: 80, rows: 24,
    version: '2.15.1', approvalMode: 'auto-safe',
  }, theme)
  assert.ok(lines.length >= 3 && lines.length <= 14, `80×24 → full header, got ${lines.length}`)
})

test('no rows provided → 3-line header (back-compat)', () => {
  const lines = formatWelcome({ modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 100 }, theme)
  assert.ok(lines.length >= 3, 'defaults to full header')
})

test('no line exceeds terminal width (display width ≤ columns)', () => {
  for (const cols of [20, 40, 80]) {
    const lines = formatWelcome({
      modelName: '天枢模型-超长名字测试-deepseek-v4-pro',
      cwd: '/Users/banxia/app/深度求索/超长中文目录名/opencode-tui',
      sessionId: '012345678',
      priorMsgCount: 3,
      columns: cols,
      version: '2.15.1',
      approvalMode: 'dangerously-skip-permissions',
    }, theme)
    for (const line of lines) {
      assert.ok(
        stringWidth(strip(line)) <= cols,
        `at cols=${cols}, line width ${stringWidth(strip(line))} should be ≤ ${cols}`,
      )
    }
  }
})
