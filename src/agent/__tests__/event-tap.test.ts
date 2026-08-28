import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { tapAgentCallbacks, type EventSink } from '../event-tap.js'
import type { AgentCallbacks } from '../loop-types.js'
import type { SessionEvent } from '../../server/protocol.js'

interface Recorded {
  events: SessionEvent[]
  calls: string[]
}

function harness(overrides: Partial<AgentCallbacks> = {}): {
  tap: ReturnType<typeof tapAgentCallbacks>
  rec: Recorded
} {
  const rec: Recorded = { events: [], calls: [] }
  const sink: EventSink = (e) => { rec.events.push(e) }

  const inner: AgentCallbacks = {
    onTextDelta: (t) => { rec.calls.push(`text:${t}`) },
    onThinkingDelta: (t) => { rec.calls.push(`think:${t}`) },
    onToolUse: (id, name) => { rec.calls.push(`use:${id}:${name}`) },
    onToolResult: (id, _n, _r, isError) => { rec.calls.push(`result:${id}:${String(isError)}`) },
    onTurnComplete: (_u, turn) => { rec.calls.push(`turn:${turn}`) },
    onError: (e) => { rec.calls.push(`error:${e.message}`) },
    onAbort: (r) => { rec.calls.push(`abort:${r ?? ''}`) },
    onApprovalRequired: async () => true,
    ...overrides,
  }

  return { tap: tapAgentCallbacks(inner, sink), rec }
}

const typesOf = (rec: Recorded): string[] => rec.events.map(e => e.type)

/** Checked index access — a missing event should fail as "没有第 N 条" rather than a TypeError. */
function at(rec: Recorded, i: number): SessionEvent {
  const event = rec.events[i]
  assert.ok(event, `没有第 ${i} 条事件（共 ${rec.events.length} 条）`)
  return event
}

describe('event-tap — 还原一次完整 turn', () => {
  test('工具调用序列可从流中完整还原（Phase 2 验收标准）', async () => {
    const { tap, rec } = harness()

    tap.onTextDelta('我来看一下 ')
    tap.onTextDelta('这个文件。')
    tap.onToolUse('t1', 'read', { path: 'src/a.ts' })
    tap.onToolResult('t1', 'read', 'file body', false)
    tap.onToolUse('t2', 'bash', { command: 'npm test' })
    tap.onToolResult('t2', 'bash', 'ok', false)
    tap.onTextDelta('测试通过。')
    tap.onTurnComplete({ input_tokens: 10 }, 1, true)

    // 消费方视角：只靠 type + data 还原调用序列，不依赖任何 TUI 内部知识。
    const sequence = rec.events
      .filter(e => e.type === 'tool_use')
      .map(e => `${String(e.data.name)}(${JSON.stringify(e.data.input)})`)

    assert.deepEqual(sequence, [
      'read({"path":"src/a.ts"})',
      'bash({"command":"npm test"})',
    ])

    // 结果与调用可经 id 配对。
    const results = new Map(
      rec.events.filter(e => e.type === 'tool_result').map(e => [e.data.id, e.data.isError]),
    )
    assert.deepEqual([...results.entries()], [['t1', false], ['t2', false]])

    assert.deepEqual(typesOf(rec), [
      'text_delta', 'tool_use', 'tool_result',
      'tool_use', 'tool_result',
      'text_delta', 'turn_complete',
    ])
  })

  test('seq 单调递增且无空洞，ts 为毫秒时间戳', () => {
    const { tap, rec } = harness()
    tap.onToolUse('a', 'read', {})
    tap.onToolResult('a', 'read', 'x', false)
    tap.onTurnComplete({}, 1, true)

    assert.deepEqual(rec.events.map(e => e.seq), [1, 2, 3])
    for (const e of rec.events) assert.ok(e.ts > 1_600_000_000_000, `ts 不像时间戳: ${e.ts}`)
  })

  test('文本先于其后的工具调用落盘 — 因果顺序不被合并打乱', () => {
    const { tap, rec } = harness()
    tap.onTextDelta('先说话')
    tap.onToolUse('t1', 'read', {})

    assert.deepEqual(typesOf(rec), ['text_delta', 'tool_use'])
    assert.equal(at(rec, 0).data.text, '先说话')
    assert.ok(at(rec, 0).seq < at(rec, 1).seq)
  })
})

describe('event-tap — delta 合并', () => {
  test('多个 delta 合成一条事件，而非每 token 一行', () => {
    const { tap, rec } = harness()
    for (const ch of ['a', 'b', 'c', 'd']) tap.onTextDelta(ch)
    tap.flush()

    assert.equal(rec.events.length, 1)
    assert.equal(at(rec, 0).data.text, 'abcd')
  })

  test('超过字符上限时提前落盘，长输出不会攒成一条巨行', () => {
    const { tap, rec } = harness()
    tap.onTextDelta('x'.repeat(4100))

    assert.equal(rec.events.length, 1)
    assert.equal(String(at(rec, 0).data.text).length, 4100)
  })

  test('text 与 thinking 交替时互不串味', () => {
    const { tap, rec } = harness()
    tap.onTextDelta('说')
    tap.onThinkingDelta('想')
    tap.onTextDelta('再说')
    tap.flush()

    assert.deepEqual(typesOf(rec), ['text_delta', 'thinking_delta', 'text_delta'])
    assert.deepEqual(rec.events.map(e => e.data.text), ['说', '想', '再说'])
  })

  test('空 delta 不产生事件', () => {
    const { tap, rec } = harness()
    tap.onTextDelta('')
    tap.flush()
    assert.equal(rec.events.length, 0)
  })

  test('flush 幂等，重复调用不重发', () => {
    const { tap, rec } = harness()
    tap.onTextDelta('a')
    tap.flush()
    tap.flush()
    assert.equal(rec.events.length, 1)
  })
})

describe('event-tap — 与 sidecar 的字段口径一致', () => {
  test('tool_use / turn_complete / approval 字段名与 session-manager 逐字对齐', async () => {
    const { tap, rec } = harness()
    tap.onToolUse('t1', 'read', { path: 'a' })
    tap.onTurnComplete({ input_tokens: 5 }, 3, true)
    await tap.onApprovalRequired('r1', 'bash', { command: 'ls' })

    const use = rec.events.find(e => e.type === 'tool_use')!
    assert.deepEqual(Object.keys(use.data).sort(), ['id', 'input', 'name'])

    const turn = rec.events.find(e => e.type === 'turn_complete')!
    assert.deepEqual(Object.keys(turn.data).sort(), ['isFinal', 'turnNumber', 'usage'])

    const req = rec.events.find(e => e.type === 'approval_required')!
    assert.deepEqual(Object.keys(req.data).sort(), ['input', 'requestId', 'toolName'])
  })

  test('流式 chunk（isError undefined）不落事件，只有终态落', () => {
    const { tap, rec } = harness()
    tap.onToolResult('t1', 'bash', 'partial…', undefined)
    tap.onToolResult('t1', 'bash', 'partial…done', false)

    assert.deepEqual(typesOf(rec), ['tool_result'])
    // 但内层照样收到两次——抽头不得改变被包裹回调的行为。
    assert.deepEqual(rec.calls, ['result:t1:undefined', 'result:t1:false'])
  })

  test('工具结果按 2000 字符截断', () => {
    const { tap, rec } = harness()
    tap.onToolResult('t1', 'bash', 'y'.repeat(5000), false)
    assert.equal(String(at(rec, 0).data.result).length, 2000)
  })

  test('abort 落 status 事件并带 reason', () => {
    const { tap, rec } = harness()
    tap.onAbort('watchdog')
    assert.equal(at(rec, 0).type, 'status')
    assert.deepEqual(at(rec, 0).data, { status: 'aborted', reason: 'watchdog' })
  })

  test('error 事件字段名为 error（非 message）', () => {
    const { tap, rec } = harness()
    tap.onError(new Error('boom'))
    assert.deepEqual(at(rec, 0).data, { error: 'boom' })
  })

  test('delegation 投影与 session-manager.appendDelegation 键名逐字对齐', () => {
    const { tap, rec } = harness({
      onDelegationActivity: () => {},
    })
    tap.onDelegationActivity!({
      workOrderId: 'batch:1',
      parentToolId: 'tool-9',
      profile: 'explore',
      authority: 'tianshu',
      status: 'running',
      objective: '查一下事件形状',
      progressLine: 'reading session-manager.ts',
      toolUseCount: 3,
      tokenCount: 1234,
    })

    const d = at(rec, 0)
    assert.equal(d.type, 'delegation')
    // 双源消费者按 data.workerId / data.parentId 取键（桌面 event-reducer）——
    // 原样转发 activity 会得到 workOrderId/parentToolId，双源客户端静默解析不到。
    assert.equal(d.data.workerId, 'batch:1')
    assert.equal(d.data.parentId, 'tool-9')
    assert.equal(d.data.phase, 'running')
    assert.equal(typeof d.data.elapsedMs, 'number')
    assert.ok(!('workOrderId' in d.data), '不应残留原样转发的 workOrderId 键')
    assert.ok(!('parentToolId' in d.data), '不应残留原样转发的 parentToolId 键')
  })

  test('delegation 终态事件的 phase 收敛为 status 本身', () => {
    const { tap, rec } = harness({
      onDelegationActivity: () => {},
    })
    tap.onDelegationActivity!({ workOrderId: 'w1', parentToolId: 't1', status: 'completed', summary: 'done' })
    const d = at(rec, 0)
    assert.equal(d.data.phase, 'completed')
    assert.equal(d.data.status, 'completed')
  })
})

describe('event-tap — 脱敏', () => {
  test('工具入参里的敏感键被遮蔽', () => {
    const { tap, rec } = harness()
    tap.onToolUse('t1', 'http', { url: 'x', headers: { authorization: 'Bearer sk-live-123' }, api_key: 'sk-abc' })

    const input = at(rec, 0).data.input as Record<string, unknown>
    assert.equal((input.headers as Record<string, unknown>).authorization, '[REDACTED]')
    assert.equal(input.api_key, '[REDACTED]')
    assert.equal(input.url, 'x')
  })

  test('文本与工具结果里的 Bearer token 被遮蔽', () => {
    const { tap, rec } = harness()
    tap.onTextDelta('curl -H "Authorization: Bearer sk-live-abc123"')
    tap.flush()
    tap.onToolResult('t1', 'bash', 'token=sk-secret-xyz', false)

    assert.ok(!String(at(rec, 0).data.text).includes('sk-live-abc123'))
    assert.ok(!String(at(rec, 1).data.result).includes('sk-secret-xyz'))
  })
})

describe('event-tap — 装饰而非替换', () => {
  test('所有内层回调仍被调用且参数不变', () => {
    const { tap, rec } = harness()
    tap.onTextDelta('a')
    tap.onThinkingDelta('b')
    tap.onToolUse('t1', 'read', {})
    tap.onToolResult('t1', 'read', 'r', true)
    tap.onTurnComplete({}, 2, false)
    tap.onError(new Error('e'))
    tap.onAbort()

    assert.deepEqual(rec.calls, [
      'text:a', 'think:b', 'use:t1:read', 'result:t1:true', 'turn:2', 'error:e', 'abort:',
    ])
  })

  test('审批返回值原样透传，并落 required + resolved 两条', async () => {
    const { tap, rec } = harness({ onApprovalRequired: async () => ({ approved: false }) })
    const result = await tap.onApprovalRequired('r1', 'bash', { command: 'rm -rf /' })

    assert.deepEqual(result, { approved: false })
    assert.deepEqual(typesOf(rec), ['approval_required', 'approval_resolved'])
    assert.equal(at(rec, 1).data.decision, 'reject')
  })

  test('布尔 true 与对象 { approved: true } 都判为 approve', async () => {
    const bool = harness({ onApprovalRequired: async () => true })
    await bool.tap.onApprovalRequired('r1', 'bash', {})
    assert.equal(at(bool.rec, 1).data.decision, 'approve')

    const obj = harness({ onApprovalRequired: async () => ({ approved: true }) })
    await obj.tap.onApprovalRequired('r1', 'bash', {})
    assert.equal(at(obj.rec, 1).data.decision, 'approve')
  })

  test('sink 抛错不影响 run —— 内层回调照常执行', () => {
    const rec: string[] = []
    const inner: AgentCallbacks = {
      onTextDelta: () => { rec.push('text') },
      onThinkingDelta: () => {},
      onToolUse: () => { rec.push('use') },
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => true,
    }
    const tap = tapAgentCallbacks(inner, () => { throw new Error('disk full') })

    assert.doesNotThrow(() => {
      tap.onTextDelta('a')
      tap.onToolUse('t1', 'read', {})
    })
    assert.deepEqual(rec, ['text', 'use'])
  })
})

describe('event-tap — 可选回调不被凭空具现', () => {
  test('内层没有 onCheckpoint / onPhaseChange 时抽头也不定义', () => {
    const { tap } = harness()
    assert.equal(tap.onCheckpoint, undefined)
    assert.equal(tap.onPhaseChange, undefined)
    assert.equal(tap.onDelegationActivity, undefined)
    assert.equal(tap.onIntentNote, undefined)
    assert.equal(tap.onDomainDrift, undefined)
  })

  test('domain drift 只在内层定义时投影为同名事件', () => {
    const seen: string[] = []
    const { tap, rec } = harness({
      onDomainDrift: (drift) => { seen.push(drift.recommendedId) },
    })

    tap.onDomainDrift!({
      currentId: 'tianliang',
      currentName: '天梁',
      recommendedId: 'tianquan',
      recommendedName: '天权',
      matchedKeywords: ['审查', '方案'],
    })

    assert.deepEqual(seen, ['tianquan'])
    assert.equal(at(rec, 0).type, 'domain_drift')
    assert.equal(at(rec, 0).data.recommendedId, 'tianquan')
  })

  test('内层定义了才包裹，并发出对应事件', () => {
    const seen: string[] = []
    const { tap, rec } = harness({
      onCheckpoint: (h) => { seen.push(`cp:${h}`) },
      onPhaseChange: (p) => { seen.push(`phase:${p}`) },
    })

    tap.onCheckpoint!('abc123')
    tap.onPhaseChange!('thinking', { tool: 'read' })

    assert.deepEqual(seen, ['cp:abc123', 'phase:thinking'])
    assert.deepEqual(typesOf(rec), ['checkpoint', 'phase'])
    assert.deepEqual(at(rec, 0).data, { hash: 'abc123' })
    assert.deepEqual(at(rec, 1).data, { phase: 'thinking', tool: 'read' })
  })

  test('onSteerDrain 不被抽头触碰 —— 有返回值的回调不能被观测改写', () => {
    const { tap } = harness({ onSteerDrain: () => 'guidance' })
    assert.equal(tap.onSteerDrain!(), 'guidance')
  })
})
