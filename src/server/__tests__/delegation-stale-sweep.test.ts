import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type PersistedSession,
  type SessionEvent,
  type SessionPersistenceAdapter,
  type SessionRecord,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * 兜底对账（sweepStaleDelegationNodes）：worker 真实死亡但终态 delegation
 * 事件没落盘时（abort 吞事件 / sidecar 重启），事件日志里永远只有 running
 * 节点，桌面端子代理面板回放后卡死「运行中」、kill 只能 409。这些用例锁定
 * 两个补终态入口：run 收尾（setImmediate）与会话首开懒加载。
 */

class NoopAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** run() 里发一个 running delegation 节点、永不发终态（模拟被吞的终态），
 *  随后 resolve —— 等价于工具层终态事件被 lifecycleGeneration 门禁丢弃后的日志形态。 */
class LostTerminalAgent implements ManagedAgent {
  constructor(private workerId: string) {}
  run(_p: string, cb: AgentCallbacks): Promise<void> {
    cb.onDelegationActivity?.({ workOrderId: this.workerId, parentToolId: 'tool_1', status: 'running' })
    return Promise.resolve()
  }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** run() 挂起直到 abort() —— 复现「worker 在跑时用户按停」的路径。 */
class HangingAgent implements ManagedAgent {
  private resolveRun?: () => void
  constructor(private workerId: string) {}
  run(_p: string, cb: AgentCallbacks): Promise<void> {
    cb.onDelegationActivity?.({ workOrderId: this.workerId, parentToolId: 'tool_1', status: 'running' })
    return new Promise<void>((res) => { this.resolveRun = res })
  }
  abort(): void { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** Abort settles after the coordinator handle disappears, while the terminal
 * callback still belongs to the pre-abort lifecycle generation. */
class DelayedSettlementAgent implements ManagedAgent {
  private resolveRun?: () => void
  private callbacks?: AgentCallbacks
  constructor(
    private readonly workerId: string,
    private readonly onWorkerGone: () => void,
  ) {}
  run(_p: string, cb: AgentCallbacks): Promise<void> {
    this.callbacks = cb
    cb.onDelegationActivity?.({ workOrderId: this.workerId, parentToolId: 'tool_1', status: 'running' })
    return new Promise<void>((res) => { this.resolveRun = res })
  }
  abort(): void {
    setTimeout(() => {
      this.onWorkerGone()
      // This callback is intentionally late: session-manager's generation gate
      // must drop it, leaving reconciliation to the post-settlement sweep.
      this.callbacks?.onDelegationActivity?.({
        workOrderId: this.workerId,
        parentToolId: 'tool_1',
        status: 'failed',
        failureReason: 'caller_aborted',
      })
      this.resolveRun?.()
    }, 15)
  }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** Lazy adapter：走懒启动路径，loadEvents 只在首开时被调。 */
class LazyMemoryPersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()

  constructor(seed: PersistedSession[] = []) {
    for (const s of seed) {
      this.records.set(s.record.id, s.record)
      this.events.set(s.record.id, s.events.slice())
    }
  }
  saveRecord(record: SessionRecord): void { this.records.set(record.id, { ...record }) }
  appendEvent(id: string, event: SessionEvent): void {
    const arr = this.events.get(id) ?? []
    arr.push(event)
    this.events.set(id, arr)
  }
  loadAll(): PersistedSession[] {
    return [...this.records.values()].map((r) => ({ record: r, events: this.events.get(r.id) ?? [] }))
  }
  loadRecords(): SessionRecord[] { return [...this.records.values()].map((r) => ({ ...r })) }
  loadEvents(id: string): SessionEvent[] {
    return (this.events.get(id) ?? []).map((e) => ({ ...e }))
  }
}

function ev(seq: number, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent {
  return { seq, ts: 100 + seq, type, data }
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

/** run 收尾的对账经 setImmediate 触发——轮询若干拍等它落盘。 */
async function waitForTerminalDelegation(
  mgr: RuntimeSessionManager,
  sessionId: string,
  workerId: string,
): Promise<SessionEvent | undefined> {
  for (let i = 0; i < 20; i++) {
    await tick()
    const found = mgr.getEvents(sessionId, 0)?.events.find(
      (e) => e.type === 'delegation' && e.data.workerId === workerId && e.data.status !== 'running',
    )
    if (found) return found
  }
  return undefined
}

async function waitForTerminalDelegationWithDelay(
  mgr: RuntimeSessionManager,
  sessionId: string,
  workerId: string,
): Promise<SessionEvent | undefined> {
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    const found = mgr.getEvents(sessionId, 0)?.events.find(
      (e) => e.type === 'delegation' && e.data.workerId === workerId && e.data.status !== 'running',
    )
    if (found) return found
  }
  return undefined
}

test('on-open sweep: stuck running node in an idle session gets a terminal event', () => {
  const persistence = new LazyMemoryPersistence([{
    record: {
      id: 's1', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [
      ev(1, 'delegation', { workerId: 'wo_1', status: 'running', objective: 'fix bug' }),
      ev(2, 'status', { status: 'completed' }),
    ],
  }])
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence,
  })

  const replay = mgr.getEvents('s1', 0)! // 首开 → ensureEvents → 对账
  const terminal = replay.events.find(
    (e) => e.type === 'delegation' && e.data.workerId === 'wo_1' && e.data.status !== 'running',
  )
  assert.ok(terminal, 'stuck running node must be closed by a terminal delegation event')
  assert.equal(terminal.data.status, 'failed')
  assert.equal(terminal.data.failureReason, 'caller_aborted')
  assert.ok(Number(terminal.data.elapsedMs) > 0, 'elapsedMs carries the real lifetime, not 0')

  // 落盘才算闭环——重启后回放同一份日志不再卡「运行中」。
  const persisted = persistence.events.get('s1')!
  assert.ok(
    persisted.some((e) => e.type === 'delegation' && e.data.workerId === 'wo_1' && e.data.status === 'failed'),
    'terminal event must be persisted, not only broadcast',
  )
})

test('on-open sweep: worker still alive in backgroundAborts is NOT swept', () => {
  const persistence = new LazyMemoryPersistence([{
    record: {
      id: 's2', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 1, pendingApprovals: 0,
    },
    events: [ev(1, 'delegation', { workerId: 'wo_live', status: 'running', objective: 'bg task' })],
  }])
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence,
  })
  // 地面真值：user 轨后台 worker 仍在跑（backgroundAborts 持有其 AbortController）。
  const internal = (mgr as unknown as { sessions: Map<string, { backgroundAborts?: Map<string, AbortController> }> })
    .sessions.get('s2')!
  internal.backgroundAborts = new Map([['wo_live', new AbortController()]])

  const replay = mgr.getEvents('s2', 0)!
  const terminal = replay.events.find(
    (e) => e.type === 'delegation' && e.data.workerId === 'wo_live' && e.data.status !== 'running',
  )
  assert.equal(terminal, undefined, 'live worker must not be marked terminal')
})

test('run-finally sweep: lost terminal event is backfilled after the run settles', async () => {
  const mgr = new RuntimeSessionManager({
    createAgent: () => new LostTerminalAgent('wo_lost'),
    defaultCwd: '/work',
    approvalTimeoutMs: 0,
    watchdogContinueDelayMs: 0,
  })
  const rec = mgr.createSession({ cwd: '/work', title: 't', prompt: 'go' })
  const terminal = await waitForTerminalDelegation(mgr, rec.id, 'wo_lost')
  assert.ok(terminal, 'run-finally sweep must backfill the swallowed terminal event')
  assert.equal(terminal.data.status, 'failed')
  mgr.shutdownAll()
})

test('abort path: worker killed mid-run gets caller_aborted terminal via sweep', async () => {
  const mgr = new RuntimeSessionManager({
    createAgent: () => new HangingAgent('wo_abort'),
    defaultCwd: '/work',
    approvalTimeoutMs: 0,
    watchdogContinueDelayMs: 0,
  })
  const rec = mgr.createSession({ cwd: '/work', title: 't', prompt: 'go' })
  await tick() // 让 run 起步、running 节点落盘
  mgr.abort(rec.id)
  const terminal = await waitForTerminalDelegation(mgr, rec.id, 'wo_abort')
  assert.ok(terminal, 'aborted worker must be closed by the sweep')
  assert.equal(terminal.data.status, 'failed')
  assert.equal(terminal.data.failureReason, 'caller_aborted')
  mgr.shutdownAll()
})

test('abort settlement sweep: delayed worker settlement is reconciled after coordinator liveness clears', async () => {
  let coordinatorLive = true
  const mgr = new RuntimeSessionManager({
    createAgent: () => new DelayedSettlementAgent('wo_delayed', () => { coordinatorLive = false }),
    defaultCwd: '/work',
    approvalTimeoutMs: 0,
    watchdogContinueDelayMs: 0,
  })
  const rec = mgr.createSession({ cwd: '/work', title: 't', prompt: 'go' })
  mgr.setCoordinatorRef(rec.id, () => ({
    isWorkerRunning: () => coordinatorLive,
  } as unknown as import('../../agent/coordinator.js').DelegationCoordinator))
  await tick()
  assert.equal(mgr.abort(rec.id), true)
  assert.equal(mgr.abort(rec.id), true, 'repeated abort remains idempotent')

  const terminal = await waitForTerminalDelegationWithDelay(mgr, rec.id, 'wo_delayed')
  assert.ok(terminal, 'post-settlement reconciliation must close a delayed worker')
  assert.equal(terminal.data.status, 'failed')
  assert.equal(terminal.data.failureReason, 'caller_aborted')
  const terminals = mgr.getEvents(rec.id, 0)!.events.filter(
    (e) => e.type === 'delegation' && e.data.workerId === 'wo_delayed' && e.data.status !== 'running',
  )
  assert.equal(terminals.length, 1, 'reconciliation must be idempotent')
  mgr.shutdownAll()
})

test('abort settlement sweep: live coordinator handle delays reconciliation without false failure', async () => {
  let coordinatorLive = true
  const mgr = new RuntimeSessionManager({
    createAgent: () => new HangingAgent('wo_lingering'),
    defaultCwd: '/work',
    approvalTimeoutMs: 0,
    watchdogContinueDelayMs: 0,
  })
  const rec = mgr.createSession({ cwd: '/work', title: 't', prompt: 'go' })
  mgr.setCoordinatorRef(rec.id, () => ({
    isWorkerRunning: () => coordinatorLive,
  } as unknown as import('../../agent/coordinator.js').DelegationCoordinator))
  await tick()
  mgr.abort(rec.id) // parent run settles immediately; coordinator lingers

  await new Promise<void>((resolve) => setTimeout(resolve, 75))
  const whileLive = mgr.getEvents(rec.id, 0)!.events.find(
    (e) => e.type === 'delegation' && e.data.workerId === 'wo_lingering' && e.data.status !== 'running',
  )
  assert.equal(whileLive, undefined, 'live coordinator ground truth must prevent false failure')

  coordinatorLive = false
  const terminal = await waitForTerminalDelegationWithDelay(mgr, rec.id, 'wo_lingering')
  assert.ok(terminal, 'retry must reconcile after coordinator liveness clears')
  assert.equal(terminal.data.failureReason, 'caller_aborted')
  mgr.shutdownAll()
})
