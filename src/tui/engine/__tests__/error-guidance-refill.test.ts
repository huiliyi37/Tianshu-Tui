/**
 * P1-4 错误时刻（UX 审计）：handleError 三件套——
 * ① 错误本体行 ② 分类终态指引行（errorRecoveryGuidance）③ 上一条回填输入框 + 告知。
 * 修复前：仅 `✗ Error: <msg>`，无指引、无回填、用户不知道上一条未送达。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './_harness.js'

const tick = () => new Promise(r => setTimeout(r, 30))
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

/** 测试内写入私有字段（回填底料）的类型窄口。 */
type RefillSeam = { lastSubmittedText: string | null }
/** inputLine 私有字段的测试窄口。 */
type InputSeam = { inputLine: { value: string; setValue(v: string): void } }

test('handleError：错误行后追加分类指引 + 回填输入框 + 未送达告知', async () => {
  const { app, out } = makeApp()
  app.setStreamingState(true)
  ;(app as unknown as RefillSeam).lastSubmittedText = '重构 auth 模块'
  out.chunks.length = 0
  app.callbacks.onError(Object.assign(new Error('rate limited'), { status: 429 }))
  await tick()
  const committed = stripAnsi(out.chunks.join(''))
  assert.ok(committed.includes('✗ Error'), '错误本体行在场')
  assert.ok(committed.includes('限流'), `429 应给限流指引，实得：${committed.slice(-300)}`)
  assert.ok(committed.includes('/model'), '指引含 /model 下一步')
  assert.ok(committed.includes('可能未被完整处理'), '回填告知在场')
  assert.equal(
    (app as unknown as InputSeam).inputLine.value,
    '重构 auth 模块',
    '输入框回填上一条原文',
  )
  assert.equal((app as unknown as RefillSeam).lastSubmittedText, null, '回填底料一次性消耗')
})

test('handleError：输入框已有草稿时不抢写（用户正在输入优先）', async () => {
  const { app, out } = makeApp()
  app.setStreamingState(true)
  ;(app as unknown as RefillSeam).lastSubmittedText = '旧任务文本'
  ;(app as unknown as InputSeam).inputLine.setValue('正在输入的草稿')
  out.chunks.length = 0
  app.callbacks.onError(new Error('boom'))
  await tick()
  assert.equal((app as unknown as InputSeam).inputLine.value, '正在输入的草稿', '有草稿时不覆盖')
  const committed = stripAnsi(out.chunks.join(''))
  assert.ok(committed.includes('可能未被完整处理'), '告知仍在（文案语义：草稿未被覆盖）')
})

test('handleError：无提交底料（如纯 slash 后报错）只出错误行与指引，不回填', async () => {
  const { app, out } = makeApp()
  app.setStreamingState(true)
  out.chunks.length = 0
  app.callbacks.onError(Object.assign(new Error('unauthorized'), { status: 401 }))
  await tick()
  const committed = stripAnsi(out.chunks.join(''))
  assert.ok(committed.includes('/connect') && committed.includes('/login'), '401 给认证指引')
  assert.ok(!committed.includes('可能未被完整处理'), '无底料不出回填告知')
  assert.equal((app as unknown as InputSeam).inputLine.value, '', '输入框保持空')
})

test('回合成功 settle 后底料清空——下一轮报错不误回填上一条', async () => {
  const { app, out } = makeApp()
  ;(app as unknown as RefillSeam).lastSubmittedText = '已完成的任务'
  app.callbacks.onTurnComplete({}, 1, true)
  // handleTurnComplete 是 async（含 blockWriter.flush 等 await 链），给足 settle 窗口
  await new Promise(r => setTimeout(r, 100))
  out.chunks.length = 0
  app.callbacks.onError(new Error('later crash'))
  await tick()
  assert.ok(!stripAnsi(out.chunks.join('')).includes('可能未被完整处理'), 'settle 后不再回填')
})
