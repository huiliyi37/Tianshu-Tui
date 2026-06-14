import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { formatWelcome } from '../format/welcome.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

test('welcome renders ≤7 lines', () => {
  const lines = formatWelcome({
    modelName: 'opus-4-8',
    cwd: '/Users/x/app/deepseek-tui/opencode-tui',
    sessionId: '878e2108abcd',
    priorMsgCount: 0,
    columns: 80,
  }, theme)
  assert.ok(lines.length <= 7, `welcome should be ≤7 lines, got ${lines.length}`)
  assert.ok(lines.length >= 2)
})

test('welcome title contains Tianshu', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 80,
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('Tianshu'), 'should contain Tianshu branding')
})

test('welcome contains model and session', () => {
  const lines = formatWelcome({
    modelName: 'glm-5.1',
    cwd: '/tmp/x',
    sessionId: 'deadbeef1234',
    priorMsgCount: 0,
    columns: 80,
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('glm-5.1'), 'should show model')
  assert.ok(joined.includes('deadbeef'), 'should show session prefix')
})

test('priorMsgCount>0 shows prior count', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 7, columns: 80,
  }, theme)
  assert.ok(lines.join('\n').includes('7 prior'), 'should show prior message count')
})

test('no line exceeds terminal width (display width ≤ columns)', () => {
  for (const cols of [20, 40, 80]) {
    const lines = formatWelcome({
      modelName: '天枢模型-超长名字测试-deepseek-v4-pro',
      cwd: '/Users/banxia/app/深度求索/超长中文目录名/opencode-tui',
      sessionId: '012345678',
      priorMsgCount: 3,
      columns: cols,
    }, theme)
    for (const line of lines) {
      assert.ok(
        stringWidth(line) <= cols,
        `at cols=${cols}, line width ${stringWidth(line)} should be ≤ ${cols}`,
      )
    }
  }
})
