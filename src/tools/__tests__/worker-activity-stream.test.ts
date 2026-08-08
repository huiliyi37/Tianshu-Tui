/**
 * T9 P3 实时上行: activity streamer 把 worker 原始活动事件折叠为
 * 有界的进度行 —— tool_use / tool_result 全量上行（有意义的进度拍点），
 * text/thinking 首次一行后静默（不再刷 deltas 计数）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createActivityStreamer, createDelegationActivityMapper, progressSnippet, shortOrderLabel } from '../worker-activity-stream.js'
import type { WorkerActivityEvent } from '../../agent/coordinator.js'
import type { DelegationActivity } from '../types.js'

function ev(over: Partial<WorkerActivityEvent>): WorkerActivityEvent {
  return { workOrderId: 'wo_abc', profile: 'code_scout', kind: 'text', ...over }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

class FakeActivityScheduler {
  private nextId = 1
  private callbacks = new Map<number, () => void>()
  private active = new Set<number>()

  setTimeout(callback: () => void, _ms: number): number {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    this.active.add(id)
    return id
  }

  clearTimeout(handle: unknown): void {
    this.active.delete(handle as number)
  }

  /** Simulate an already-queued callback even after clearTimeout. */
  runQueued(id: number): void {
    this.active.delete(id)
    this.callbacks.get(id)?.()
  }

  get handles(): number[] {
    return [...this.callbacks.keys()]
  }

  get size(): number {
    return this.active.size
  }
}

describe('shortOrderLabel', () => {
  it('strips wo_ prefix and takes the last colon segment', () => {
    assert.equal(shortOrderLabel('wo_abc123'), 'abc123')
    assert.equal(shortOrderLabel('team:T1'), 'T1')
    assert.equal(shortOrderLabel('wo_team:T2'), 'T2')
  })
})

describe('progressSnippet', () => {
  it('压平嵌入换行/制表符后截断（live region 单行契约）', () => {
    // 真实泄漏链：review 门 evidence 用 \n 拼接 → progressLine → 舰队面板活动行
    const multi = '⚠️ 审查未决 (auto)\nreview DID NOT run (infra failure)\n\tretry also failed'
    const snippet = progressSnippet(multi)
    assert.ok(!snippet.includes('\n'), '片段不得携带换行')
    assert.ok(!snippet.includes('\t'), '片段不得携带制表符')
    assert.match(snippet, /审查未决 \(auto\) review DID NOT run/)
  })

  it('按 max 截断并 trim 首尾空白', () => {
    assert.equal(progressSnippet('  abc  '), 'abc')
    assert.equal(progressSnippet('abcdef', 3), 'abc')
  })
})

describe('createActivityStreamer', () => {
  it('emits a line for every tool_use with the tool name', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'tool_use', detail: 'read_file' }))
    stream(ev({ kind: 'tool_use', detail: 'grep' }))
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /abc·code_scout.*read_file/)
    assert.match(lines[1]!, /grep/)
  })

  it('text: 首个 delta 输出一行「写作中」，之后静默', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'text', detail: 'x' }))
    stream(ev({ kind: 'text', detail: 'y' }))
    stream(ev({ kind: 'text', detail: 'z' }))
    // 只有首次输出一行，后续不再刷屏
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /写作中/)
  })

  it('tool_result 输出完成行', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'tool_result', detail: 'read_file' }))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /完成/)
  })

  it('per work order 独立追踪 text 首次标志', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ workOrderId: 'wo_a', kind: 'text' }))
    stream(ev({ workOrderId: 'wo_b', kind: 'text' }))
    // 两个 worker 各自首次 text → 两行
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /\ba·/)
    assert.match(lines[1]!, /\bb·/)
  })

  it('thinking: 首次输出「思考中」', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'thinking', workOrderId: 'wo_x' }))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /思考中/)
  })

  it('turn 计数心跳不产生文本行', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'turn', detail: '1200' }))
    assert.equal(lines.length, 0)
  })

  it('lifecycle: 每一轮补偿都出行，不像 retry 那样只报一次', () => {
    const lines: string[] = []
    const stream = createActivityStreamer(l => lines.push(l))
    stream(ev({ kind: 'lifecycle', detail: '续跑 1/2 · 轮次预算耗尽' }))
    stream(ev({ kind: 'lifecycle', detail: '续跑 2/2 · 轮次预算耗尽' }))
    assert.equal(lines.length, 2, '第二次续跑必须也可见——用户最想知道的就是它跑到第几次了')
    assert.match(lines[0]!, /续跑 1\/2/)
    assert.match(lines[1]!, /续跑 2\/2/)
  })
})

describe('createDelegationActivityMapper', () => {
  it('finish 先 flush pending 再发终态，迟到 timer/raw activity 不得复活 worker', () => {
    const acts: DelegationActivity[] = []
    const scheduler = new FakeActivityScheduler()
    const map = createDelegationActivityMapper('p', a => acts.push(a), { scheduler })

    map(ev({ workOrderId: 'wo_a', kind: 'text', detail: 'tail' }))
    const [timer] = scheduler.handles
    map.finish({ workOrderId: 'wo_a', parentToolId: 'p', status: 'passed', summary: 'done' })

    assert.deepEqual(acts.map(a => [a.status, a.eventKind, a.eventDetail]), [
      ['running', 'text', 'tail'],
      ['passed', undefined, undefined],
    ])
    assert.equal(scheduler.size, 0)
    scheduler.runQueued(timer!)
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', detail: 'late-tool' }))
    assert.equal(acts.length, 2, 'seal 后 queued timer 与 raw activity 都必须被丢弃')
  })

  it('重置 timer 后，旧 queued callback 不能提前 flush 当前 slot', () => {
    const acts: DelegationActivity[] = []
    const scheduler = new FakeActivityScheduler()
    const map = createDelegationActivityMapper('p', a => acts.push(a), { scheduler })

    map(ev({ workOrderId: 'wo_a', kind: 'text', detail: 'A' }))
    const firstTimer = scheduler.handles.at(-1)!
    map(ev({ workOrderId: 'wo_a', kind: 'text', detail: 'B' }))
    const secondTimer = scheduler.handles.at(-1)!

    scheduler.runQueued(firstTimer)
    assert.equal(acts.length, 0, '已取消但入队的旧 callback 不得 flush 新 timer 所属 slot')
    scheduler.runQueued(secondTimer)
    assert.equal(acts.length, 1)
    assert.equal(acts[0]!.eventDetail, 'AB')
  })

  it('dispose 清空 timer/state，并永久忽略后续 raw/finish', () => {
    const acts: DelegationActivity[] = []
    const scheduler = new FakeActivityScheduler()
    const map = createDelegationActivityMapper('p', a => acts.push(a), { scheduler })

    map(ev({ workOrderId: 'wo_a', kind: 'thinking', detail: 'pending' }))
    const [timer] = scheduler.handles
    assert.equal(scheduler.size, 1)
    map.dispose()
    assert.equal(scheduler.size, 0)

    scheduler.runQueued(timer!)
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', detail: 'late' }))
    map.finish({ workOrderId: 'wo_a', parentToolId: 'p', status: 'failed' })
    assert.deepEqual(acts, [])
  })

  it('sink throw 被隔离，finish 仍 seal 且不会重复发射', () => {
    const attempted: DelegationActivity[] = []
    const scheduler = new FakeActivityScheduler()
    const map = createDelegationActivityMapper('p', a => {
      attempted.push(a)
      throw new Error('ui sink failed')
    }, { scheduler })

    map(ev({ workOrderId: 'wo_a', kind: 'text', detail: 'tail' }))
    const [timer] = scheduler.handles
    assert.doesNotThrow(() => {
      map.finish({ workOrderId: 'wo_a', parentToolId: 'p', status: 'blocked' })
    })
    assert.deepEqual(attempted.map(a => a.status), ['running', 'blocked'])

    assert.doesNotThrow(() => scheduler.runQueued(timer!))
    assert.doesNotThrow(() => map(ev({ workOrderId: 'wo_a', kind: 'tool_use' })))
    assert.deepEqual(attempted.map(a => a.status), ['running', 'blocked'])
  })

  it('成功终态幂等；终态 sink throw 不标记 finished，backstop 可重试一次', () => {
    const attempted: DelegationActivity[] = []
    let terminalAttempts = 0
    const map = createDelegationActivityMapper('p', a => {
      attempted.push(a)
      if (a.status !== 'running' && terminalAttempts++ === 0) throw new Error('terminal sink failed')
    })

    const terminal: DelegationActivity = {
      workOrderId: 'wo_a', parentToolId: 'p', status: 'failed', summary: 'nope',
    }
    map.finish(terminal)
    map.finish(terminal)
    map.finish(terminal)

    assert.deepEqual(attempted.map(a => a.status), ['failed', 'failed'])
    // First attempt threw, so one retry succeeded; later duplicate finish is ignored.
    assert.equal(terminalAttempts, 2)
  })

  it('同一 stable worker 的新 attempt 可在同一 mapper 中重新派发', () => {
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a))

    map(ev({ workOrderId: 'team:planner-tianquan', attemptId: 'attempt-1', kind: 'tool_use' }))
    map.finish({
      workOrderId: 'team:planner-tianquan', parentToolId: 'p', attemptId: 'attempt-1', status: 'passed',
    })
    map(ev({ workOrderId: 'team:planner-tianquan', attemptId: 'attempt-2', kind: 'tool_use' }))
    map.finish({
      workOrderId: 'team:planner-tianquan', parentToolId: 'p', attemptId: 'attempt-2', status: 'failed',
    })

    assert.deepEqual(acts.map(a => [a.attemptId, a.status]), [
      ['attempt-1', 'running'],
      ['attempt-1', 'passed'],
      ['attempt-2', 'running'],
      ['attempt-2', 'failed'],
    ])
    assert.deepEqual(
      acts.filter(a => a.status === 'running').map(a => a.toolUseCount),
      [1, 1],
    )
  })

  it('tool_use 累计计数，turn 事件更新 tokenCount', () => {
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('parent_1', a => acts.push(a))
    map(ev({ kind: 'tool_use', detail: 'read_file' }))
    map(ev({ kind: 'tool_use', detail: 'grep' }))
    map(ev({ kind: 'turn', detail: '1500' }))
    assert.equal(acts.length, 3)
    assert.equal(acts[0]!.toolUseCount, 1)
    assert.equal(acts[1]!.toolUseCount, 2)
    // turn 事件：无 progressLine、计数保留、tokenCount 到位
    assert.equal(acts[2]!.progressLine, undefined)
    assert.equal(acts[2]!.toolUseCount, 2)
    assert.equal(acts[2]!.tokenCount, 1500)
    assert.equal(acts[2]!.parentToolId, 'parent_1')
    assert.equal(acts[2]!.status, 'running')
  })

  it('per work order 独立计数；tokenCount 只增不减', () => {
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use' }))
    map(ev({ workOrderId: 'wo_b', kind: 'tool_use' }))
    map(ev({ workOrderId: 'wo_a', kind: 'turn', detail: '2000' }))
    map(ev({ workOrderId: 'wo_a', kind: 'turn', detail: '900' }))
    const a = acts.filter(x => x.workOrderId === 'wo_a')
    const b = acts.filter(x => x.workOrderId === 'wo_b')
    assert.equal(a[0]!.toolUseCount, 1)
    assert.equal(b[0]!.toolUseCount, 1)
    // 迟到的较小 token 快照不回退
    assert.equal(a[2]!.tokenCount, 2000)
  })

  it('objective 仅在首条 running 事件携带（查表或 event.objective）', async () => {
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a), {
      objectiveOf: (id) => id === 'wo_a' ? 'find auth bugs' : undefined,
      coalesceMs: 5,
    })
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', detail: 'grep' }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', detail: 'read_file' }))
    map(ev({ workOrderId: 'wo_b', kind: 'tool_use', objective: 'from coordinator' }))
    map(ev({ workOrderId: 'wo_b', kind: 'text', detail: 'x' }))
    await sleep(30)  // text 经尾沿合并后发出
    assert.equal(acts[0]!.objective, 'find auth bugs')
    assert.equal(acts[1]!.objective, undefined)
    assert.equal(acts[2]!.objective, 'from coordinator')
    assert.equal(acts[3]!.objective, undefined)
  })

  it('contract 仅在首条事件携带（event.contract 首选，contractOf 兜底）——死接线回归防线', () => {
    const contract = {
      objective: 'audit auth flow',
      profile: 'code_scout',
      scope: {},
      constraints: [],
      budget: { maxTurns: 8, timeoutMs: 120_000 },
      allowedToolsDigest: 'grep,read_file +2',
    }
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a), {
      contractOf: (id) => id === 'wo_fallback' ? contract : undefined,
    })
    // coordinator 随事件携带（生产主路径：objective 恒存在）
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'audit auth flow', contract }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'audit auth flow', contract }))
    assert.deepEqual(acts[0]!.contract, contract)
    assert.equal(acts[1]!.contract, undefined, 'contract 只随首条事件转发')
    // 工具侧兜底查表（event.contract 缺席时）
    map(ev({ workOrderId: 'wo_fallback', kind: 'tool_use', objective: 'x' }))
    assert.deepEqual(acts[2]!.contract, contract)
  })

  it('objective 为空时 contract 仍只发一次——两者分开记账', async () => {
    // objective 的「查不到就下条再试」是有意的（objectiveOf 首条可能还没就绪），
    // 但那道守卫曾连 contract 一起管：objective 恰好为空时 contract 跟着每条重发，
    // 下游按「首条才带」去重就会为同一 worker 反复打派发卡。
    const contract = {
      objective: 'audit auth flow',
      profile: 'code_scout',
      scope: {},
      constraints: [],
      budget: { maxTurns: 8, timeoutMs: 120_000 },
      allowedToolsDigest: 'grep,read_file +2',
    }
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a), { coalesceMs: 5 })
    // objective 全程缺席（coordinator 未附带、无 objectiveOf 兜底）
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', contract }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', contract }))
    map(ev({ workOrderId: 'wo_a', kind: 'text', contract }))
    await sleep(30)  // text 经尾沿合并后发出
    assert.deepEqual(acts[0]!.contract, contract, '首条仍带 contract')
    assert.equal(acts[1]!.contract, undefined)
    assert.equal(acts[2]!.contract, undefined)
    assert.ok(acts.every(a => a.objective === undefined), 'objective 始终缺席（不影响 contract 记账）')
  })

  it('contract 晚到时补发一次（首条无、次条有）', () => {
    const contract = {
      objective: 'x',
      profile: 'code_scout',
      scope: {},
      constraints: [],
      budget: { maxTurns: 4, timeoutMs: 60_000 },
      allowedToolsDigest: 'grep +1',
    }
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'x' }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'x', contract }))
    map(ev({ workOrderId: 'wo_a', kind: 'tool_use', objective: 'x', contract }))
    assert.equal(acts[0]!.contract, undefined)
    assert.deepEqual(acts[1]!.contract, contract, '晚到的 contract 补发，不因 objective 已记账而被吞')
    assert.equal(acts[2]!.contract, undefined)
  })

  it('lifecycle 事件带阶段文案上行，且不污染工具/token 计数', () => {
    const acts: DelegationActivity[] = []
    const map = createDelegationActivityMapper('p', a => acts.push(a))
    map(ev({ kind: 'tool_use', detail: 'grep' }))
    map(ev({ kind: 'lifecycle', detail: '续跑 1/2 · 轮次预算耗尽' }))
    assert.equal(acts[1]!.eventKind, 'lifecycle')
    assert.match(acts[1]!.progressLine!, /续跑 1\/2/)
    assert.equal(acts[1]!.toolUseCount, 1, '补偿轮播报不是一次工具调用')
    assert.equal(acts[1]!.tokenCount, undefined)
  })

  describe('text/thinking 尾沿合并', () => {
    it('窗口内连续 text delta 合并为一条，eventDetail 字节完整', async () => {
      const acts: DelegationActivity[] = []
      const map = createDelegationActivityMapper('p', a => acts.push(a), { coalesceMs: 20 })
      map(ev({ kind: 'text', detail: 'Hello, ' }))
      map(ev({ kind: 'text', detail: '世界' }))
      map(ev({ kind: 'text', detail: '！\n第二行' }))
      assert.equal(acts.length, 0, '窗口未满不得提前发出')
      await sleep(60)
      assert.equal(acts.length, 1, '尾沿到时发出且仅发出一条')
      assert.equal(acts[0]!.eventKind, 'text')
      // WorkerMirrorStore 靠 eventDetail 重建完整转录——多字节/换行一个字节都不能丢
      assert.equal(acts[0]!.eventDetail, 'Hello, 世界！\n第二行')
      assert.equal(acts[0]!.progressLine, '写入中')
    })

    it('合并事件携带发出时的最新 toolUseCount/tokenCount', async () => {
      const acts: DelegationActivity[] = []
      const map = createDelegationActivityMapper('p', a => acts.push(a), { coalesceMs: 20 })
      map(ev({ kind: 'tool_use', detail: 'grep' }))
      map(ev({ kind: 'tool_use', detail: 'read_file' }))
      map(ev({ kind: 'turn', detail: '3200' }))
      map(ev({ kind: 'text', detail: 'a' }))
      map(ev({ kind: 'text', detail: 'b' }))
      await sleep(60)
      assert.equal(acts.length, 4)
      const merged = acts[3]!
      assert.equal(merged.eventDetail, 'ab')
      assert.equal(merged.toolUseCount, 2)
      assert.equal(merged.tokenCount, 3200)
    })

    it('text→thinking 切换：先 flush 旧槽，再开新槽', async () => {
      const acts: DelegationActivity[] = []
      const map = createDelegationActivityMapper('p', a => acts.push(a), { coalesceMs: 20 })
      map(ev({ kind: 'text', detail: '正文一' }))
      map(ev({ kind: 'text', detail: '正文二' }))
      map(ev({ kind: 'thinking', detail: '推理' }))
      // kind 切换立即 flush text 槽，不等定时器
      assert.equal(acts.length, 1)
      assert.equal(acts[0]!.eventKind, 'text')
      assert.equal(acts[0]!.eventDetail, '正文一正文二')
      await sleep(60)
      assert.equal(acts.length, 2)
      assert.equal(acts[1]!.eventKind, 'thinking')
      assert.equal(acts[1]!.eventDetail, '推理')
      assert.equal(acts[1]!.progressLine, '思考中')
    })

    it('tool_use 到达前先 flush pending text，tool_use 即时透传（顺序断言）', () => {
      const acts: DelegationActivity[] = []
      // 大窗口证明不依赖定时器：flush + 透传都是同步完成的
      const map = createDelegationActivityMapper('p', a => acts.push(a), { coalesceMs: 10_000 })
      map(ev({ kind: 'text', detail: '片段A' }))
      map(ev({ kind: 'text', detail: '片段B' }))
      map(ev({ kind: 'tool_use', detail: 'grep' }))
      assert.equal(acts.length, 2, 'flush 与 tool_use 透传都是同步的')
      assert.equal(acts[0]!.eventKind, 'text')
      assert.equal(acts[0]!.eventDetail, '片段A片段B')
      assert.equal(acts[0]!.toolUseCount, 0, 'flush 按到达时序携带 tool_use 之前的计数')
      assert.equal(acts[1]!.eventKind, 'tool_use')
      assert.equal(acts[1]!.eventDetail, 'grep')
      assert.equal(acts[1]!.toolUseCount, 1)
    })

    it('非流式事件不延迟（tool_result/turn/lifecycle/retry 即时透传）', () => {
      const acts: DelegationActivity[] = []
      const map = createDelegationActivityMapper('p', a => acts.push(a), { coalesceMs: 10_000 })
      map(ev({ kind: 'tool_result', detail: 'grep' }))
      map(ev({ kind: 'turn', detail: '100' }))
      map(ev({ kind: 'lifecycle', detail: '续跑 1/2' }))
      map(ev({ kind: 'retry' }))
      assert.equal(acts.length, 4)
      assert.deepEqual(acts.map(a => a.eventKind), ['tool_result', 'turn', 'lifecycle', 'retry'])
    })

    it('尾沿定时器到时真实发出（真实定时器，非 fake timer）', async () => {
      const acts: DelegationActivity[] = []
      const map = createDelegationActivityMapper('p', a => acts.push(a), { coalesceMs: 30 })
      map(ev({ kind: 'thinking', detail: '想' }))
      assert.equal(acts.length, 0)
      await sleep(15)
      assert.equal(acts.length, 0, '窗口未满不得发出')
      await sleep(60)
      assert.equal(acts.length, 1, '尾沿定时器到时必须发出')
      assert.equal(acts[0]!.eventDetail, '想')
    })

    it('首条被发出的事件仍携带 objective——即使它被合并延迟', async () => {
      const acts: DelegationActivity[] = []
      const map = createDelegationActivityMapper('p', a => acts.push(a), {
        coalesceMs: 20,
        objectiveOf: (id) => id === 'wo_a' ? 'find auth bugs' : undefined,
      })
      map(ev({ workOrderId: 'wo_a', kind: 'text', detail: 'x' }))
      map(ev({ workOrderId: 'wo_a', kind: 'text', detail: 'y' }))
      assert.equal(acts.length, 0)
      await sleep(60)
      assert.equal(acts[0]!.objective, 'find auth bugs', '首条发出事件（合并 text）必须携带 objective')
      map(ev({ workOrderId: 'wo_a', kind: 'tool_use', detail: 'grep' }))
      assert.equal(acts[1]!.objective, undefined, '后续事件不再重复携带')
    })

    it('pending 槽 per-worker 独立：wo_b 的 tool_use 不冲掉 wo_a 的槽', async () => {
      const acts: DelegationActivity[] = []
      const map = createDelegationActivityMapper('p', a => acts.push(a), { coalesceMs: 20 })
      map(ev({ workOrderId: 'wo_a', kind: 'text', detail: 'A' }))
      map(ev({ workOrderId: 'wo_b', kind: 'text', detail: 'B' }))
      map(ev({ workOrderId: 'wo_b', kind: 'tool_use', detail: 'grep' }))
      assert.deepEqual(acts.map(a => [a.workOrderId, a.eventKind]), [
        ['wo_b', 'text'],
        ['wo_b', 'tool_use'],
      ], '只有 wo_b 自己的 pending 被 flush')
      await sleep(60)
      assert.equal(acts.length, 3)
      assert.equal(acts[2]!.workOrderId, 'wo_a')
      assert.equal(acts[2]!.eventDetail, 'A')
    })
  })
})
