import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { formatWelcome } from '../format/welcome.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

test('welcome 精简为 ≤7 行（含北斗勺形星图）', () => {
  const lines = formatWelcome({
    modelName: 'opus-4-8',
    cwd: '/Users/x/app/deepseek-tui/opencode-tui',
    sessionId: '878e2108abcd',
    priorMsgCount: 0,
    columns: 80,
  }, theme)
  assert.ok(lines.length <= 7, `欢迎应 ≤7 行，实际 ${lines.length}`)
  assert.ok(lines.length >= 2)
})

test('welcome 标题为 天枢 · Tiānshū，含北斗勺口首星 ●', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 0, columns: 80,
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('天枢'), '应含中文星名')
  assert.ok(joined.includes('Tiānshū'), '应含罗马音')
  assert.ok(joined.includes('●'), '北斗勺口首星(天枢)用 ● 落印')
  assert.ok(joined.includes('·'), '其余星点用 ·')
})

test('welcome 包含 model 与 session', () => {
  const lines = formatWelcome({
    modelName: 'glm-5.1',
    cwd: '/tmp/x',
    sessionId: 'deadbeef1234',
    priorMsgCount: 0,
    columns: 80,
  }, theme)
  const joined = lines.join('\n')
  assert.ok(joined.includes('glm-5.1'), '应显示 model')
  assert.ok(joined.includes('deadbeef'), '应显示 session 前缀')
})

test('priorMsgCount>0 时提示历史消息数', () => {
  const lines = formatWelcome({
    modelName: 'm', cwd: '/x', sessionId: 'abcdefgh', priorMsgCount: 7, columns: 80,
  }, theme)
  assert.ok(lines.join('\n').includes('7 prior'), '应提示 prior 消息数')
})

test('窄终端 / CJK 不溢出列宽（display width ≤ columns）', () => {
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
        `列宽 ${cols} 下应不溢出，但有一行宽度 ${stringWidth(line)}`,
      )
    }
  }
})
