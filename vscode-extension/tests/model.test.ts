import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialChatState, reduceEvent, type ChatState } from '../webview-ui/src/model.ts'

function feed(events: Array<{ type: string; data: Record<string, unknown> }>): ChatState {
  let state = initialChatState
  let seq = 0
  for (const e of events) {
    state = reduceEvent(state, { seq: ++seq, ts: seq, type: e.type, data: e.data })
  }
  return state
}

test('连续 text_delta 并入同一 assistant 气泡', () => {
  const s = feed([
    { type: 'user', data: { text: '你好' } },
    { type: 'text_delta', data: { text: '天' } },
    { type: 'text_delta', data: { text: '枢' } },
  ])
  assert.equal(s.items.length, 2)
  assert.deepEqual(s.items[1], { kind: 'assistant', text: '天枢' })
})

test('tool_result 分块按 id 追加到对应 tool 卡', () => {
  const s = feed([
    { type: 'tool_use', data: { id: 't1', name: 'bash', input: { command: 'ls' } } },
    { type: 'text_delta', data: { text: 'x' } },
    { type: 'tool_result', data: { id: 't1', name: 'bash', isError: false, result: 'a\n' } },
    { type: 'tool_result', data: { id: 't1', name: 'bash', isError: false, result: 'b' } },
  ])
  const tool = s.items[0]
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind === 'tool') {
    assert.equal(tool.result, 'a\nb')
    assert.equal(tool.isError, false)
  }
})

test('审批 required/resolved 按 requestId 配对并维护 pending 计数', () => {
  const s1 = feed([
    { type: 'approval_required', data: { requestId: 'r1', toolName: 'bash', input: { command: 'rm x' } } },
  ])
  assert.equal(s1.pendingApprovals, 1)
  const s2 = reduceEvent(s1, { seq: 9, ts: 9, type: 'approval_resolved', data: { requestId: 'r1', decision: 'deny' } })
  assert.equal(s2.pendingApprovals, 0)
  const card = s2.items[0]
  if (card?.kind === 'approval') assert.equal(card.decision, 'deny')
  else assert.fail('expected approval card')
})

test('未知事件类型透传忽略（向后兼容）', () => {
  const s = feed([
    { type: 'text_delta', data: { text: 'hi' } },
    { type: 'some_future_event', data: { anything: true } },
  ])
  assert.equal(s.items.length, 1)
})

test('plan_submitted 带 slug 出计划卡，同 slug 状态更新原位刷新', () => {
  const s1 = feed([
    { type: 'plan_submitted', data: { slug: 'p-1', title: '重构计划', status: 'submitted' } },
  ])
  assert.deepEqual(s1.items[0], { kind: 'plan', slug: 'p-1', title: '重构计划', status: 'submitted' })

  const s2 = reduceEvent(s1, {
    seq: 9, ts: 9, type: 'plan_submitted',
    data: { slug: 'p-1', title: '重构计划', status: 'rejected' },
  })
  assert.equal(s2.items.length, 1)
  assert.deepEqual(s2.items[0], { kind: 'plan', slug: 'p-1', title: '重构计划', status: 'rejected' })
})

test('plan_submitted 无 slug 时回退 info 提示（旧内核兼容）', () => {
  const s = feed([{ type: 'plan_submitted', data: {} }])
  assert.equal(s.items[0]?.kind, 'info')
})

test('plan_draft 置起草指示，submit / 退出 plan mode 时清除', () => {
  const s1 = feed([
    { type: 'plan_mode', data: { state: 'planning' } },
    { type: 'plan_draft', data: { slug: 'p-1' } },
  ])
  assert.equal(s1.planDrafting, true)

  const submitted = reduceEvent(s1, {
    seq: 9, ts: 9, type: 'plan_submitted', data: { slug: 'p-1', title: 'T', status: 'submitted' },
  })
  assert.equal(submitted.planDrafting, false)

  const exited = reduceEvent(s1, { seq: 9, ts: 9, type: 'plan_mode', data: { state: 'off' } })
  assert.equal(exited.planDrafting, false)
})

test('text_delta 中插入 tool 后新 delta 开新气泡', () => {
  const s = feed([
    { type: 'text_delta', data: { text: '前' } },
    { type: 'tool_use', data: { id: 't1', name: 'read_file', input: {} } },
    { type: 'text_delta', data: { text: '后' } },
  ])
  assert.equal(s.items.length, 3)
  assert.deepEqual(s.items[2], { kind: 'assistant', text: '后' })
})

test('done 事件落终态，status 不再滞留 running（下条消息走 prompt 而非 steer）', () => {
  const running = feed([
    { type: 'user', data: { text: 'hi' } },
    { type: 'status', data: { status: 'running' } },
  ])
  assert.equal(running.status, 'running')

  const settled = reduceEvent(running, { seq: 9, ts: 9, type: 'done', data: { status: 'completed' } })
  assert.equal(settled.status, 'completed')
  assert.notEqual(settled.status, 'running')

  // 旧内核极端情况：done 缺 status 字段也不能卡 running
  const fallback = reduceEvent(running, { seq: 9, ts: 9, type: 'done', data: {} })
  assert.equal(fallback.status, 'idle')
})

test('turn_complete 带 usage 出用量脚注（字段按 snake_case 口径取值）', () => {
  const s = feed([
    { type: 'user', data: { text: '跑一下' } },
    { type: 'text_delta', data: { text: '完成' } },
    { type: 'turn_complete', data: { turnNumber: 1, isFinal: true, usage: { input_tokens: 10000, output_tokens: 300, cache_read_input_tokens: 9200, cache_creation_input_tokens: 500 } } },
  ])
  const foot = s.items[2]
  assert.equal(foot?.kind, 'usage')
  if (foot?.kind === 'usage') {
    assert.equal(foot.input, 10000)
    assert.equal(foot.output, 300)
    assert.equal(foot.cacheRead, 9200)
    assert.equal(foot.cacheCreate, 500)
  }
})

test('resume_offer 置可续跑，running 后清除', () => {
  const offered = feed([{ type: 'resume_offer', data: {} }])
  assert.equal(offered.resumeOffer, true)

  const running = reduceEvent(offered, { seq: 9, ts: 9, type: 'status', data: { status: 'running' } })
  assert.equal(running.resumeOffer, false)

  const done = reduceEvent(offered, { seq: 10, ts: 10, type: 'done', data: { status: 'completed' } })
  assert.equal(done.resumeOffer, false)
})

test('autonomy_checkpoint: paused 出暂停卡，未暂停只出进度条', () => {
  const paused = feed([{ type: 'autonomy_checkpoint', data: { turns: 8, digest: '已改 3 文件', paused: true } }])
  assert.deepEqual(paused.items[0], {
    kind: 'checkpoint',
    variant: 'autonomy',
    turns: 8,
    digest: '已改 3 文件',
    paused: true,
  })

  const ping = feed([{ type: 'autonomy_checkpoint', data: { turns: 4, digest: '继续跑', paused: false } }])
  assert.equal(ping.items[0]?.kind, 'checkpoint')
  if (ping.items[0]?.kind === 'checkpoint') assert.equal(ping.items[0].paused, false)
})

test('watchdog_recovery: 停止/待续出卡；suppressed 忽略；自动恢复走 info', () => {
  const stopped = feed([{ type: 'watchdog_recovery', data: { autoContinue: false, reason: 'watchdog-stall' } }])
  assert.deepEqual(stopped.items[0], { kind: 'checkpoint', variant: 'watchdog', paused: true })

  const pending = feed([{ type: 'watchdog_recovery', data: { autoContinue: true, pendingAutoContinue: true } }])
  assert.equal(pending.items[0]?.kind, 'checkpoint')

  const recovered = feed([{ type: 'watchdog_recovery', data: { autoContinue: true } }])
  assert.equal(recovered.items[0]?.kind, 'info')

  const suppressed = feed([{ type: 'watchdog_recovery', data: { stopReason: 'suppressed' } }])
  assert.equal(suppressed.items.length, 0)
})

test('replay_window: 磁盘更早则 canLoadEarlier；重连 floor 不回缩', () => {
  const first = feed([{ type: 'replay_window', data: { floorSeq: 80, diskFirstSeq: 1, diskLastSeq: 90 } }])
  assert.equal(first.canLoadEarlier, true)
  assert.equal(first.historyFloorSeq, 80)

  const recon = reduceEvent(first, {
    seq: 0, ts: 1, type: 'replay_window',
    data: { floorSeq: 90, diskFirstSeq: 1, diskLastSeq: 95 },
  })
  assert.equal(recon.historyFloorSeq, 80)
  assert.equal(recon.canLoadEarlier, true)

  const flushed = feed([{ type: 'replay_window', data: { floorSeq: 1, diskFirstSeq: 1 } }])
  assert.equal(flushed.canLoadEarlier, false)
})

test('phase 警告入 info 卡；steer_delivered 出送达回执', () => {
  const warn = feed([{ type: 'phase', data: { phase: '⚠ 历史上下文为空' } }])
  assert.equal(warn.items[0]?.kind, 'info')
  assert.equal(warn.phase, '⚠ 历史上下文为空')

  const live = feed([{ type: 'phase', data: { phase: 'compacting' } }])
  assert.equal(live.items.length, 0)
  assert.equal(live.phase, 'compacting')

  const delivered = feed([{ type: 'steer_delivered', data: { count: 2 } }])
  assert.equal(delivered.items[0]?.kind, 'info')
  if (delivered.items[0]?.kind === 'info') assert.match(delivered.items[0].text, /2/)
})

test('user 事件带 seq', () => {
  const s = reduceEvent(initialChatState, { seq: 7, ts: 1, type: 'user', data: { text: 'hello' } })
  assert.deepEqual(s.items[0], { kind: 'user', text: 'hello', seq: 7 })
})

test('rewind: anchorSeq 截断该 user 及之后', () => {
  let s = initialChatState
  s = reduceEvent(s, { seq: 10, ts: 1, type: 'user', data: { text: 'task A' } })
  s = reduceEvent(s, { seq: 11, ts: 2, type: 'text_delta', data: { text: 'doing A' } })
  s = reduceEvent(s, { seq: 20, ts: 3, type: 'user', data: { text: 'task B' } })
  s = reduceEvent(s, { seq: 21, ts: 4, type: 'text_delta', data: { text: 'doing B' } })
  s = reduceEvent(s, { seq: 22, ts: 5, type: 'resume_offer', data: {} })
  s = reduceEvent(s, { seq: 30, ts: 6, type: 'rewind', data: { prompt: 'task B', anchorSeq: 20 } })
  assert.deepEqual(s.items.map((it) => it.kind), ['user', 'assistant', 'info'])
  if (s.items[0]?.kind === 'user') {
    assert.equal(s.items[0].text, 'task A')
    assert.equal(s.items[0].seq, 10)
  } else assert.fail('expected user')
  if (s.items[2]?.kind === 'info') assert.match(s.items[2].text, /已退回/)
  else assert.fail('expected info')
  assert.equal(s.status, 'idle')
  assert.equal(s.resumeOffer, false)
})

test('rewind: 同文案多条只切锚点那条', () => {
  let s = initialChatState
  s = reduceEvent(s, { seq: 1, ts: 1, type: 'user', data: { text: 'do it' } })
  s = reduceEvent(s, { seq: 2, ts: 2, type: 'text_delta', data: { text: 'r1' } })
  s = reduceEvent(s, { seq: 3, ts: 3, type: 'user', data: { text: 'do it' } })
  s = reduceEvent(s, { seq: 4, ts: 4, type: 'text_delta', data: { text: 'r2' } })
  s = reduceEvent(s, { seq: 5, ts: 5, type: 'rewind', data: { prompt: 'do it', anchorSeq: 1 } })
  assert.deepEqual(s.items.map((it) => it.kind), ['info'])
})

test('rewind: 无锚点不误切', () => {
  let s = initialChatState
  s = reduceEvent(s, { seq: 10, ts: 1, type: 'user', data: { text: 'keep me' } })
  s = reduceEvent(s, { seq: 11, ts: 2, type: 'text_delta', data: { text: 'ok' } })
  s = reduceEvent(s, { seq: 20, ts: 3, type: 'rewind', data: { prompt: 'not in list' } })
  assert.equal(s.items.length, 3)
  assert.equal(s.items[0]?.kind, 'user')
  assert.equal(s.items[1]?.kind, 'assistant')
  assert.equal(s.items[2]?.kind, 'info')
  if (s.items[0]?.kind === 'user') assert.equal(s.items[0].text, 'keep me')
})

test('queue_pending 出卡；同 lane 翻 steered；retracted 删卡', () => {
  const pending = feed([{ type: 'queue_pending', data: { laneId: 'q1', text: '接着补测试' } }])
  assert.deepEqual(pending.items[0], { kind: 'queue', text: '接着补测试', laneId: 'q1', status: 'queued' })

  const steered = reduceEvent(pending, { seq: 9, ts: 9, type: 'queue_status', data: { laneId: 'q1', status: 'steered' } })
  if (steered.items[0]?.kind === 'queue') assert.equal(steered.items[0].status, 'steered')
  else assert.fail('expected queue card')

  const gone = reduceEvent(pending, { seq: 9, ts: 9, type: 'queue_status', data: { laneId: 'q1', status: 'retracted' } })
  assert.equal(gone.items.length, 0)
})

test('steer_delivered 只翻 steered 卡；未知 lane 不误动', () => {
  const s1 = feed([
    { type: 'queue_pending', data: { laneId: 'q1', text: '升级我' } },
    { type: 'queue_pending', data: { laneId: 'q2', text: '留在队列' } },
    { type: 'queue_status', data: { laneId: 'q1', status: 'steered' } },
  ])
  const delivered = reduceEvent(s1, { seq: 9, ts: 9, type: 'steer_delivered', data: { count: 1 } })
  const q1 = delivered.items.find((it) => it.kind === 'queue' && it.laneId === 'q1')
  const q2 = delivered.items.find((it) => it.kind === 'queue' && it.laneId === 'q2')
  if (q1?.kind === 'queue') assert.equal(q1.status, 'delivered')
  else assert.fail('q1')
  if (q2?.kind === 'queue') assert.equal(q2.status, 'queued')
  else assert.fail('q2')

  const noop = reduceEvent(s1, { seq: 10, ts: 10, type: 'queue_status', data: { laneId: 'nope', status: 'steered' } })
  assert.equal(noop.items.filter((it) => it.kind === 'queue').length, 2)
})

test('turn_complete 无 usage 或全零不出脚注（旧内核/合成事件容错）', () => {
  const noUsage = feed([
    { type: 'text_delta', data: { text: 'x' } },
    { type: 'turn_complete', data: { turnNumber: 1, isFinal: true } },
  ])
  assert.equal(noUsage.items.length, 1)

  const zero = feed([
    { type: 'text_delta', data: { text: 'x' } },
    { type: 'turn_complete', data: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ])
  assert.equal(zero.items.length, 1)
})
