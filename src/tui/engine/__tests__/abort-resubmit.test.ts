/**
 * T9 abort → resubmit 死会话回归测试（0A：统一 streaming 权威 + 世代守卫）。
 *
 * Bug：agent 卡在工具上时按 Esc/Ctrl+C 终止，之后怎么发消息都没反应。
 * 根因：main-ansi 模块级 isStreaming 与 TuiApp.agentBusy 双门，清除时机不同——
 * Esc 同步清 TuiApp 却从不清 main-ansi 的 isStreaming，下次 submit 被 `if(isStreaming)return` 吞，
 * 再后续输入又被 agentBusy 路由进 steerBuffer，会话彻底卡死。
 *
 * 契约：
 *  1. agentBusy 是唯一权威；abort 后再 submit 必须重新触发 onSubmit（不被吞、不入 steerBuffer）。
 *  2. wrapCallbacksWithTuiApp 捕获 run 世代；abort 后旧 run 的迟到回调被丢弃，
 *     不得清掉新 run 的 busy / 污染渲染（反向竞态）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { wrapCallbacksWithTuiApp } from '../bridge.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  return { app, out, stdin }
}

const tick = () => new Promise(r => setTimeout(r, 10))

test('卡死的 run 被 Ctrl+C 中止后，再 submit 重新触发 onSubmit（不被吞、不入队）', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  // 模拟 main-ansi：每次 onSubmit 即发起一次新 run（但本测试里 run 永不结束）
  app.onSubmit((t) => { runs.push(t) })

  // run A：submit → agentBusy=true，onSubmit('first') 触发，run 挂起不结束
  app.setInput('first')
  stdin.dataHandler!('\r')
  await tick()
  assert.deepEqual(runs, ['first'], 'run A 已发起')
  assert.equal(app.busy, true, '挂起的 run 使 agentBusy=true')

  // Ctrl+C 中止挂起的 run
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(app.busy, false, 'abort 后 agentBusy 同步复位')

  // run B：再次 submit → 必须重新触发 onSubmit，而非被吞或入 steerBuffer
  app.setInput('second')
  stdin.dataHandler!('\r')
  await tick()
  assert.deepEqual(runs, ['first', 'second'], 'abort 后 submit 必须重新发起 run')
  assert.equal(app.steerBuffer.hasPending(), false, '不得把新输入塞进 steerBuffer')
})

test('abort 后旧 run 的迟到 onAbort 被世代守卫丢弃，不清掉新 run 的 busy', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => { /* run 挂起 */ })

  // run A 开始 → 此刻 main-ansi 会 wrap 一组回调（捕获 A 的世代）
  app.setInput('A')
  stdin.dataHandler!('\r')
  await tick()
  const staleCallbacks = wrapCallbacksWithTuiApp(app)

  // 用户中止 run A（runGen 自增）
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(app.busy, false)

  // run B 开始（agentBusy 再次 true，世代为新值）
  app.setInput('B')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.busy, true, 'run B 正在执行')

  // run A 的循环此刻才真正 settle，迟到 onAbort 抵达 —— 必须被丢弃
  staleCallbacks.onAbort()
  assert.equal(app.busy, true, "旧 run A 的迟到 onAbort 不得清掉 run B 的 busy")
})

test('goal 模式 watchdog abort 自动续跑，但连续 stall 达上限后停手', async () => {
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  // 连续 5 次 watchdog:goal abort（每次重新 wrap 以越过世代守卫——
  // handleAbort 会自增 runGen）。前 3 次自动续跑，第 4/5 次到上限停手。
  for (let i = 0; i < 5; i++) {
    wrapCallbacksWithTuiApp(app).onAbort('watchdog:goal')
    await tick()
  }
  const continues = runs.filter((r) => r === 'continue').length
  assert.equal(continues, 3, `自动续跑应被 MAX_WATCHDOG_AUTO_CONTINUES 限制为 3 次，实得 ${continues}`)
})

test('用户提交重置 watchdog 自动续跑计数，恢复完整续跑预算', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  // 耗尽续跑预算
  for (let i = 0; i < 4; i++) {
    wrapCallbacksWithTuiApp(app).onAbort('watchdog:goal')
    await tick()
  }
  assert.equal(runs.filter((r) => r === 'continue').length, 3, '先耗尽到 3 次')

  // 用户手动提交 → 重置计数（真实进度）
  app.setInput('manual progress')
  stdin.dataHandler!('\r')
  await tick()

  // 再来一次 watchdog:goal → 应重新获得续跑
  wrapCallbacksWithTuiApp(app).onAbort('watchdog:goal')
  await tick()
  assert.equal(runs.filter((r) => r === 'continue').length, 4, '用户提交后应恢复续跑预算')
})

test('世代守卫：旧 run 的迟到 onApprovalRequired 自动拒绝', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})

  app.setInput('A')
  stdin.dataHandler!('\r')
  await tick()
  const staleCallbacks = wrapCallbacksWithTuiApp(app)

  stdin.dataHandler!('\x03') // abort run A → 世代自增
  await tick()

  const result = await staleCallbacks.onApprovalRequired('t1', 'bash', { command: 'rm -rf /' })
  assert.equal(result, false, '已死 run 的审批请求应自动拒绝，不弹 UI')
})

test('挂起审批时 watchdog:goal abort 不自动续跑（等待用户批准，切断 deny→continue→deny 环）', async () => {
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  const cb = wrapCallbacksWithTuiApp(app)
  // 触发审批挂起（promise 保持 pending 直到 abort 将其解析为拒绝）。
  const pending = cb.onApprovalRequired('t1', 'edit_file', { file_path: 'x.ts' })
  await tick()
  // 卡在审批上时 watchdog 开火：绝不能自动 continue，否则重发同一被拒调用成环。
  cb.onAbort('watchdog:goal')
  await tick()

  assert.equal(await pending, false, '挂起审批在 abort 时被解析为拒绝')
  assert.equal(runs.filter((r) => r === 'continue').length, 0, '审批挂起时不得自动续跑')
})

test('session 总量上限防止 tiny-turn 重置循环无限续跑', async () => {
  // Bug: consecutive cap (3) 在任意 turn 完成时重置为 0。
  // tiny-turn（thinking-retry / phantom-continue）只需产生微量输出
  // 就能触发 handleTurnComplete → 重置计数器 → stall→recover→tiny-turn
  // 循环永不停。session total cap 不重置，兜底阻止这个漏洞。
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  // 模拟 15 个 stall→recover→tiny-turn 循环
  for (let i = 0; i < 15; i++) {
    // watchdog:goal abort → 触发自动续跑
    wrapCallbacksWithTuiApp(app).onAbort('watchdog:goal')
    await tick()

    // tiny-turn 完成 → 重置 consecutive cap（不重置 session total）
    wrapCallbacksWithTuiApp(app).onTurnComplete({ output_tokens: 10 }, 1, false)
    await tick()
  }

  // 前 12 次应自动续跑（session total cap = 12），之后停手
  const continues = runs.filter((r) => r === 'continue').length
  assert.equal(continues, 12, `session total cap 应在 12 次后停手，实得 ${continues}`)
})

// ── v3: 进度单元感知计数 ────────────────────────────────────────
// progressUnits = (onTurnComplete 次数) + (onToolResult 次数)
// 密集 stall（< THRESHOLD=4）计 session 配额；稀疏 stall（>= 4）不计。
// ────────────────────────────────────────────────────────────

test('A2: stall 间仅 1 个工具批（3 单元 < 阈值 4）仍计配额', async () => {
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  for (let i = 0; i < 15; i++) {
    const cb = wrapCallbacksWithTuiApp(app)
    // 1 completion + 2 tool results = 3 单元，仍低于阈值 4
    cb.onToolResult(`t${i}a`, 'read_file', 'ok', false)
    cb.onToolResult(`t${i}b`, 'grep', 'ok', false)
    cb.onTurnComplete({ output_tokens: 10 }, 1, false)
    await tick()
    cb.onAbort('watchdog:goal')
    await tick()
  }

  const continues = runs.filter((r) => r === 'continue').length
  assert.equal(continues, 12, `3 单元/周期应计配额并在 12 次后停手，实得 ${continues}`)
})

test('A3: 流式 chunk（isError=undefined）不计进度单元，只有终态结果才算', async () => {
  // 回归：进度计数曾在 handleToolResult 入口自增，长输出工具（bash/test）
  // 每个流式 chunk 都被算作一个"进度单元"——单次工具调用喷 4+ chunk 就能
  // 凑满阈值 4，把每个密集 stall 都伪装成稀疏，session 配额永远不消耗。
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  for (let i = 0; i < 15; i++) {
    const cb = wrapCallbacksWithTuiApp(app)
    // 单次工具调用：4 个流式 chunk + 1 个终态 → 正确计 1 单元（chunk 不算）
    for (let j = 0; j < 4; j++) {
      cb.onToolResult(`t${i}`, 'bash', `chunk ${j}\n`)   // isError=undefined
    }
    cb.onToolResult(`t${i}`, 'bash', 'done', false)       // 终态
    cb.onTurnComplete({ output_tokens: 10 }, 1, false)
    await tick()
    // 每周期 2 单元（1 终态 + 1 completion）< 阈值 4 → 密集，计配额
    cb.onAbort('watchdog:goal')
    await tick()
  }

  const continues = runs.filter((r) => r === 'continue').length
  assert.equal(continues, 12,
    `流式 chunk 若被误计为进度，密集 stall 会被伪装成稀疏而无限续跑；应 12 次后停手，实得 ${continues}`)
})

test('B: 稀疏 stall（每次间隔 2+ 工具批）不消耗 session-total 配额', async () => {
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  for (let i = 0; i < 20; i++) {
    const cb = wrapCallbacksWithTuiApp(app)
    // 2 个工具批：2 completion + 2 tool results = 4 单元 = 阈值
    for (let j = 0; j < 2; j++) {
      cb.onToolResult(`t${i}-${j}`, 'read_file', 'ok', false)
      cb.onTurnComplete({ output_tokens: 10 }, 1, false)
      await tick()
    }
    cb.onAbort('watchdog:goal')
    await tick()
  }

  // 每周期 4 单元 >= 阈值 → sessionTotal 从不增长 → 20 次全部续跑
  const continues = runs.filter((r) => r === 'continue').length
  assert.equal(continues, 20, `稀疏 stall 应持续续跑 20 次，实得 ${continues}`)
})

test('C: sessionTotal 跨稀疏段累计：密集 11 次→稀疏 5 次→密集第 12 次后停手', async () => {
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  const dense = async () => {
    const cb = wrapCallbacksWithTuiApp(app)
    cb.onTurnComplete({ output_tokens: 10 }, 1, false)  // tiny-turn 重置 consecutive
    await tick()
    cb.onAbort('watchdog:goal')
    await tick()
  }
  const sparse = async () => {
    const cb = wrapCallbacksWithTuiApp(app)
    for (let j = 0; j < 3; j++) {
      cb.onToolResult(`s${j}`, 'bash', 'ok', false)
      cb.onTurnComplete({ output_tokens: 10 }, 1, false)
      await tick()
    }
    cb.onAbort('watchdog:goal')
    await tick()
  }

  for (let i = 0; i < 11; i++) await dense()   // sessionTotal: 11
  for (let i = 0; i < 5; i++) await sparse()   // sessionTotal: 不变（11）
  await dense()                                 // sessionTotal: 12
  await dense()                                 // exhausted → 不续跑

  const continues = runs.filter((r) => r === 'continue').length
  assert.equal(continues, 17, `11 密 + 5 疏 + 1 密 = 17 次续跑，第 18 次停手，实得 ${continues}`)
})

test('D: suppressForApproval 的 stall 不清零进度计数（不发起续跑也不计配额）', async () => {
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  // 判别原理：单看"审批后第一次 stall 是否续跑"无法区分对错实现——dense/sparse
  // 只影响私有的 sessionTotal，配额未耗尽时两种实现都会续跑。可观测的判别量是
  // **配额耗尽前的总续跑次数**：
  //   正确实现（审批 stall 保留进度）：审批前积累的 4 单元让审批后第一次 stall
  //   判定稀疏（免费），随后 13 个密集周期消耗配额 1..12 → 总续跑 13 次。
  //   错误实现（审批 stall 清零进度）：第一次 stall 就是密集（计配额），
  //   12 次耗尽 → 总续跑 12 次。

  // 阶段 1：积累 4 单元进度（3 tool results + 1 completion）
  const cb1 = wrapCallbacksWithTuiApp(app)
  cb1.onToolResult('p1', 'read_file', 'ok', false)
  cb1.onToolResult('p2', 'read_file', 'ok', false)
  cb1.onToolResult('p3', 'grep', 'ok', false)
  cb1.onTurnComplete({ output_tokens: 10 }, 1, false)
  await tick()

  // 阶段 2：审批挂起的 stall → suppressForApproval，不续跑、不得清零进度
  const pending = cb1.onApprovalRequired('t1', 'edit_file', { file_path: 'x.ts' })
  await tick()
  cb1.onAbort('watchdog:goal')
  await tick()
  assert.equal(await pending, false, '挂起审批在 abort 时被解析为拒绝')
  assert.equal(runs.filter((r) => r === 'continue').length, 0, '审批挂起的 stall 不得续跑')

  // 跳过 5s approval grace 窗口：回拨拒绝时间戳（真实 setTimeout 会拖慢套件）。
  // private 仅 TS 层生效，运行时可直接写。
  ;(app as unknown as { _lastApprovalDeniedAt: number })._lastApprovalDeniedAt = 0

  // 阶段 3：14 个密集周期（tiny-turn + stall）。第一个周期的 stall 时进度应为
  // 审批前的 4 单元 + 本周期 tiny-turn 1 单元 = 5（稀疏，免费）；此后每周期 1 单元
  // （密集，计配额 1..12）。
  for (let i = 0; i < 14; i++) {
    const cb = wrapCallbacksWithTuiApp(app)
    cb.onTurnComplete({ output_tokens: 10 }, 1, false)   // tiny-turn：重置 consecutive
    await tick()
    cb.onAbort('watchdog:goal')
    await tick()
  }

  const continues = runs.filter((r) => r === 'continue').length
  assert.equal(continues, 13,
    `审批 stall 保留进度 → 首个后续 stall 免费 + 12 次配额 = 13 次续跑（清零则只有 12），实得 ${continues}`)
})

test('E: 普通 watchdog abort（非 goal）自动续跑，受同一套 cap 约束', async () => {
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  wrapCallbacksWithTuiApp(app).onAbort('watchdog')   // 注意：不是 watchdog:goal
  await tick()
  assert.equal(runs.filter((r) => r === 'continue').length, 1,
    '非 goal watchdog 也应自动续跑')

  // 密集 stall 下 cap 同样生效（跑到 12 次停手）
  for (let i = 0; i < 15; i++) {
    const cb = wrapCallbacksWithTuiApp(app)
    cb.onTurnComplete({ output_tokens: 10 }, 1, false)
    await tick()
    cb.onAbort('watchdog')
    await tick()
  }
  const totalContinues = runs.filter((r) => r === 'continue').length
  assert.equal(totalContinues, 12, `非 goal watchdog 密集 stall 也应在 12 次后停手，实得 ${totalContinues}`)
})

test('F: 输入框有未提交草稿时 watchdog abort 不自动续跑', async () => {
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  app.setInput('用户打了一半的字')          // 未回车
  wrapCallbacksWithTuiApp(app).onAbort('watchdog:goal')
  await tick()

  assert.equal(runs.filter((r) => r === 'continue').length, 0,
    '有草稿时必须让位给用户，不抢跑')
})

test('G: convergence abort 不受 watchdog 泛化影响，仍不自动续跑', async () => {
  const { app } = makeApp()
  const runs: string[] = []
  app.onSubmit((t) => { runs.push(t) })

  wrapCallbacksWithTuiApp(app).onAbort('convergence:no-tool')
  await tick()
  assert.equal(runs.length, 0, 'convergence 中断不得自动续跑')
})
