import type { CoordinatorRun, WorkerActivityEvent } from '../agent/coordinator.js'
import type { ContractProjection } from '../agent/contract-projection.js'
import type { DelegationActivity, DelegationIdentity } from './types.js'
import type { OutputStreamScheduler } from './output-stream-budget.js'

/** Shorten a work order id to a human label: "wo_team:T1" → "T1". */
export function shortOrderLabel(workOrderId: string): string {
  const seg = workOrderId.split(':').pop() ?? workOrderId
  return seg.replace(/^wo_/, '').slice(0, 12)
}

/**
 * 单行进度片段：压平空白（含 \n/\r/\t）后截断。
 *
 * progressLine / activity 最终落进 TUI live region 的单行槽位——worker 的
 * summary/detail 是自由文本（review 门 evidence 甚至显式用 \n 拼接），
 * 直接 slice 会把嵌入换行带进渲染行，破坏 LiveEngine 的显示行数追踪
 * （输入框重影根因之一）。所有进度片段截断必须走这里。
 */
export function progressSnippet(text: string, max = 80): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

/** terminalActivity 的调用侧微调项——五处委派工具共享一份实现后的差异开关。 */
export interface TerminalActivityOptions {
  /** 显式 authority 覆盖：给了（含 undefined）就以它为准，没给回退 result.authority。 */
  authority?: string
  /** result.profile 缺失时的兜底（council 传 'council_expert'）。 */
  profileFallback?: string
  /** 终态事件不带 profile 字段（delegate_task 的原行为）。 */
  omitProfile?: boolean
  /** 终态事件不带 artifactId/changedFiles（council 的原行为）。 */
  omitArtifacts?: boolean
}

/**
 * WorkerResult → 终态 DelegationActivity 的统一构造器。delegate_task /
 * delegate_batch / galaxy / team_orchestrate / council_convene 五处共用——
 * 历史上是五份近乎逐字的复制，差异只剩上面四个开关。配合 mapper.finish()
 * 发出：终态排在合并尾沿之后且幂等。
 */
export function terminalActivity(
  result: CoordinatorRun['results'][number],
  parentToolId: string,
  objective?: string,
  opts?: TerminalActivityOptions,
): DelegationActivity {
  const identity = result as CoordinatorRun['results'][number] & DelegationIdentity
  const authority = opts && 'authority' in opts ? opts.authority : result.authority
  return {
    workOrderId: result.workOrderId,
    parentToolId,
    ...(identity.dispatchId ? { dispatchId: identity.dispatchId } : {}),
    ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
    ...(identity.parentAttemptId ? { parentAttemptId: identity.parentAttemptId } : {}),
    ...(opts?.omitProfile ? {} : { profile: result.profile ?? opts?.profileFallback }),
    authority,
    objective,
    status: result.status === 'passed' ? 'completed' : result.status,
    progressLine: progressSnippet(result.summary),
    summary: result.summary,
    failureReason: result.failureReason,
    model: result.model,
    provider: result.provider,
    usage: result.usage,
    ...(opts?.omitArtifacts ? {} : {
      artifactId: result.diffArtifactId,
      changedFiles: result.changedFiles.length > 0 ? result.changedFiles : undefined,
    }),
    findingsCount: result.findings.length > 0 ? result.findings.length : undefined,
    topFinding: result.findings[0]?.claim,
    verificationBrief: result.verification
      ? { status: result.verification.status, passed: result.verification.passed, failed: result.verification.failed }
      : undefined,
    evidenceStatus: result.evidenceStatus,
  }
}

/**
 * One concise progress line for a worker activity event, for the structured
 * subagent fleet panel.
 */
export function activityProgressLine(event: WorkerActivityEvent): string {
  if (event.kind === 'tool_use') return `⚙ ${event.detail ? progressSnippet(event.detail, 60) : '工具调用'}`
  if (event.kind === 'tool_result') return `✓ ${event.detail ? progressSnippet(event.detail, 50) : '完成'}`
  if (event.kind === 'thinking') return '思考中'
  if (event.kind === 'retry') return '↻ 上游重试'
  // lifecycle：派发侧补发的阶段短语（续跑 / 证据复核），detail 已是成句中文。
  if (event.kind === 'lifecycle') return event.detail ? `↻ ${progressSnippet(event.detail, 60)}` : '↻ 补偿轮'
  if (event.kind === 'turn') return ''
  return '写入中'
}

export interface DelegationActivityMapperOpts {
  /** Resolve the worker objective by workOrderId. Objective is attached only
   *  on the first running event per worker to keep the SSE stream small. */
  objectiveOf?: (workOrderId: string) => string | undefined
  /** Resolve the contract projection by workOrderId. Like objective, only
   *  attached on the first running event per worker. */
  contractOf?: (workOrderId: string) => ContractProjection | undefined
  /** text/thinking delta 尾沿合并窗口（ms），默认 120。测试可注入小值。 */
  coalesceMs?: number
  /** Injectable timer seam for deterministic lifecycle tests. */
  scheduler?: OutputStreamScheduler
}

export interface DelegationActivityMapperController {
  (event: WorkerActivityEvent): void
  /** Flush one worker, or every pending worker when omitted. */
  flush(workOrderId?: string): void
  /** Flush and permanently reject further running events for this worker. */
  seal(workOrderId: string): void
  /** Seal first, then emit one terminal activity. */
  finish(activity: DelegationActivity): void
  /** Cancel every timer and reject all future activity. */
  dispose(): void
}

const DEFAULT_COALESCE_MS = 120

function activityAttemptKey(activity: {
  workOrderId: string
  attemptId?: string
  dispatchId?: string
}): string {
  if (activity.attemptId) return `attempt:${activity.attemptId}`
  if (activity.dispatchId) return `dispatch:${activity.dispatchId}:${activity.workOrderId}`
  return `legacy:${activity.workOrderId}`
}

/** text/thinking 尾沿合并槽：同 kind 连续 delta 累积进 parts，到时/切换/非流式事件触发 flush。 */
interface PendingStreamSlot {
  /** Object identity plus generation fence stale queued timer callbacks. */
  timerGeneration: number
  kind: 'text' | 'thinking'
  parts: string[]
  /** 首个 delta 原样保留作透传基底（profile/authority/objective/contract）。 */
  base: WorkerActivityEvent
  /** 组成事件里首个非空 objective/contract（可能晚于首个 delta 才携带）。 */
  objective?: string
  contract?: ContractProjection
  timer?: unknown
}

const defaultActivityScheduler: OutputStreamScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * 共享的 WorkerActivityEvent → DelegationActivity 映射器。
 *
 * 在事件流上按派发 attempt 聚合计数。无 identity 的旧事件仍按
 * stable worker 归约，保持历史会话的兼容性：
 * - tool_use 事件累计工具调用次数
 * - turn 事件携带累计 token 总数（worker 每 turn 结束上报一次）
 * 每条 running 事件都带上最新计数，读模型（FleetRegistry / 桌面面板）只做归约。
 * objective 仅在该 attempt 首条 running 事件携带（避免每 tick 重复传输）。
 *
 * text/thinking delta 做 per-attempt 尾沿合并（默认 120ms）：同 kind 连续 delta
 * 累积为一条发出，eventDetail 是 parts 拼接全文（下游 WorkerMirrorStore 靠它重建
 * 完整转录，一个字节都不能丢）——否则每个 token 一条事件会打满 TUI 帧。flush
 * 触发：尾沿定时器到时 / 同 worker kind 切换（text↔thinking，先 flush 旧槽再起
 * 新槽）/ 该 worker 任意非流式事件到达（非流式事件不合并、不延迟，先 flush 再
 * 即时透传，保持时序）。
 */
export function createDelegationActivityMapper(
  parentToolId: string,
  onWorkerActivity: (activity: DelegationActivity) => void,
  opts?: DelegationActivityMapperOpts,
): DelegationActivityMapperController {
  // Runtime identity isolates redispatches of a stable workOrderId. Legacy
  // activity has no identity and therefore retains the original worker key.
  const counters = new Map<string, { toolUseCount: number; tokenCount: number }>()
  const objectiveSent = new Set<string>()
  // contract 与 objective 分开记账。objective 的「没查到就下条再试」是有意的
  // （objectiveOf 查表可能首条事件时还没就绪），但那道守卫此前连 contract 一起
  // 管着——objective 恰好为空时，contract 会跟着每条事件重发，下游按「首条才带」
  // 的约定去重就会漏。
  const contractSent = new Set<string>()
  const coalesceMs = opts?.coalesceMs ?? DEFAULT_COALESCE_MS
  const scheduler = opts?.scheduler ?? defaultActivityScheduler
  // pending 槽 flush 即删；槽数受单次委派的 worker 数约束，不随事件流增长。
  const pending = new Map<string, PendingStreamSlot>()
  const sealed = new Set<string>()
  const sealedWorkers = new Set<string>()
  const finished = new Set<string>()
  const attemptOwners = new Map<string, string>()
  let disposed = false

  const counterOf = (attemptKey: string) => {
    let c = counters.get(attemptKey)
    if (!c) {
      c = { toolUseCount: 0, tokenCount: 0 }
      counters.set(attemptKey, c)
    }
    return c
  }

  const safeEmit = (activity: DelegationActivity): boolean => {
    if (disposed) return false
    try {
      onWorkerActivity(activity)
      return true
    } catch {
      // UI/activity sinks are observational and must not break worker dispatch.
      return false
    }
  }

  // objective/contract 的「首条携带、查不到下条再试」以发出时刻为准。
  const emitRunning = (event: WorkerActivityEvent, detail: string | undefined) => {
    const attemptKey = activityAttemptKey(event)
    const c = counterOf(attemptKey)
    const line = activityProgressLine(event)
    let objective: string | undefined
    let contract: ContractProjection | undefined
    if (!objectiveSent.has(attemptKey)) {
      // Prefer coordinator-attached objective; fall back to tool-side lookup.
      objective = event.objective ?? opts?.objectiveOf?.(event.workOrderId)
      if (objective) objectiveSent.add(attemptKey)
    }
    if (!contractSent.has(attemptKey)) {
      // Contract: coordinator 随事件携带（首选）；contractOf 为工具侧兜底。
      contract = event.contract ?? opts?.contractOf?.(event.workOrderId)
      if (contract) contractSent.add(attemptKey)
    }
    const identity = event as WorkerActivityEvent & {
      attemptId?: string
      dispatchId?: string
      parentAttemptId?: string
    }
    safeEmit({
      workOrderId: event.workOrderId,
      parentToolId,
      ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
      ...(identity.dispatchId ? { dispatchId: identity.dispatchId } : {}),
      ...(identity.parentAttemptId ? { parentAttemptId: identity.parentAttemptId } : {}),
      profile: event.profile,
      authority: event.authority,
      authorityReason: event.authorityReason,
      status: 'running',
      ...(objective ? { objective } : {}),
      progressLine: line || undefined,
      toolUseCount: c.toolUseCount,
      tokenCount: c.tokenCount > 0 ? c.tokenCount : undefined,
      eventKind: event.kind,
      eventDetail: detail,
      ...(contract ? { contract } : {}),
    } as DelegationActivity)
  }

  const cancelSlotTimer = (slot: PendingStreamSlot): void => {
    slot.timerGeneration += 1
    if (slot.timer === undefined) return
    scheduler.clearTimeout(slot.timer)
    slot.timer = undefined
  }

  const flushPending = (
    attemptKey: string,
    expectedSlot?: PendingStreamSlot,
    allowSealed = false,
  ): void => {
    const slot = pending.get(attemptKey)
    if (!slot || (expectedSlot && slot !== expectedSlot)) return
    cancelSlotTimer(slot)
    pending.delete(attemptKey)
    if (disposed || (!allowSealed && sealed.has(attemptKey))) return
    const merged: WorkerActivityEvent = { ...slot.base }
    if (slot.objective !== undefined) merged.objective = slot.objective
    if (slot.contract !== undefined) merged.contract = slot.contract
    emitRunning(merged, slot.parts.join(''))
  }

  const flush = (workOrderId?: string): void => {
    if (disposed) return
    if (workOrderId !== undefined) {
      for (const [attemptKey, slot] of [...pending.entries()]) {
        if (slot.base.workOrderId === workOrderId) flushPending(attemptKey)
      }
      return
    }
    for (const attemptKey of [...pending.keys()]) flushPending(attemptKey)
  }

  const sealAttempt = (attemptKey: string): void => {
    if (disposed || sealed.has(attemptKey)) return
    // Mark closed before flushing so re-entrant sink callbacks cannot reopen it.
    sealed.add(attemptKey)
    flushPending(attemptKey, undefined, true)
    counters.delete(attemptKey)
    objectiveSent.delete(attemptKey)
    contractSent.delete(attemptKey)
  }

  const seal = (workOrderId: string): void => {
    if (disposed) return
    sealedWorkers.add(workOrderId)
    const keys = [...attemptOwners.entries()]
      .filter(([, owner]) => owner === workOrderId)
      .map(([attemptKey]) => attemptKey)
    if (keys.length === 0) keys.push(activityAttemptKey({ workOrderId }))
    for (const attemptKey of keys) sealAttempt(attemptKey)
  }

  const finish = (activity: DelegationActivity): void => {
    if (disposed) return
    const attemptKey = activityAttemptKey(activity)
    attemptOwners.set(attemptKey, activity.workOrderId)
    if (activity.status === 'running' || finished.has(attemptKey)) return
    sealAttempt(attemptKey)
    if (safeEmit(activity)) finished.add(attemptKey)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const slot of pending.values()) cancelSlotTimer(slot)
    pending.clear()
    counters.clear()
    objectiveSent.clear()
    contractSent.clear()
    sealed.clear()
    sealedWorkers.clear()
    finished.clear()
    attemptOwners.clear()
  }

  const mapper = ((event: WorkerActivityEvent) => {
    if (disposed) return
    const attemptKey = activityAttemptKey(event)
    attemptOwners.set(attemptKey, event.workOrderId)
    if (sealedWorkers.has(event.workOrderId) || sealed.has(attemptKey)) return
    if (event.kind === 'text' || event.kind === 'thinking') {
      const cur = pending.get(attemptKey)
      if (cur && cur.kind !== event.kind) flushPending(attemptKey)
      let slot = pending.get(attemptKey)
      if (!slot) {
        slot = { timerGeneration: 0, kind: event.kind, parts: [], base: event }
        pending.set(attemptKey, slot)
      }
      if (event.detail) slot.parts.push(event.detail)
      if (slot.objective === undefined && event.objective !== undefined) slot.objective = event.objective
      if (slot.contract === undefined && event.contract !== undefined) slot.contract = event.contract
      // 尾沿定时器：每个新 delta 重置；unref 不拖进程退出。
      cancelSlotTimer(slot)
      const generation = ++slot.timerGeneration
      const expectedSlot = slot
      let timer: unknown
      timer = scheduler.setTimeout(() => {
        if (disposed || sealedWorkers.has(event.workOrderId) || sealed.has(attemptKey)) return
        if (pending.get(attemptKey) !== expectedSlot) return
        if (expectedSlot.timerGeneration !== generation || expectedSlot.timer !== timer) return
        flushPending(attemptKey, expectedSlot)
      }, coalesceMs)
      slot.timer = timer
      ;(timer as { unref?: () => void })?.unref?.()
      return
    }
    // 非流式事件：先 flush 该 worker 的 pending（合并事件按到达时序携带此前计数），
    // 再更新计数并即时透传本事件。
    flushPending(attemptKey)
    const c = counterOf(attemptKey)
    if (event.kind === 'tool_use') c.toolUseCount += 1
    if (event.kind === 'turn') {
      const n = Number(event.detail)
      if (Number.isFinite(n) && n > c.tokenCount) c.tokenCount = n
    }
    emitRunning(event, event.detail)
  }) as DelegationActivityMapperController

  mapper.flush = flush
  mapper.seal = seal
  mapper.finish = finish
  mapper.dispose = dispose
  return mapper
}

/**
 * T9 P3 实时上行: convert raw worker activity events into a bounded stream of
 * progress lines for the live tool card.
 *
 * V2 改进：
 * - text 心跳不再输出 deltas 计数行（用户不需要 token 吞吐量）
 * - 首次 text 只输出一次「写作中」，之后静默
 * - tool_use / tool_result 始终输出（一行一条）
 */
export function createActivityStreamer(
  emit: (line: string) => void,
  _opts?: { textEvery?: number },
): (event: WorkerActivityEvent) => void {
  const textSeen = new Set<string>()
  const retrySeen = new Set<string>()

  return (event: WorkerActivityEvent) => {
    if (event.kind === 'turn') return  // 计数心跳，不产生文本行
    const label = `${shortOrderLabel(event.workOrderId)}·${event.profile}`
    if (event.kind === 'tool_use') {
      const toolDetail = event.detail ? ` ${progressSnippet(event.detail, 60)}` : ''
      emit(`  ↳ [${label}] ⚙${toolDetail}\n`)
      return
    }
    if (event.kind === 'tool_result') {
      const resultHint = event.detail ? ` (${progressSnippet(event.detail, 40)})` : ''
      emit(`  ↳ [${label}] ✓ 完成${resultHint}\n`)
      return
    }
    // lifecycle: 补偿轮开场（续跑 / 证据复核）。整次派发最多几条，不去重——
    // 「第几次续跑」正是用户想看的，压掉就只剩一段无解释的沉默。
    if (event.kind === 'lifecycle') {
      if (event.detail) emit(`  ↳ [${label}] ↻ ${progressSnippet(event.detail, 60)}\n`)
      return
    }
    // retry: 上游内部重试（慢 ≠ 死）——每个 worker 只报一次，避免刷屏
    if (event.kind === 'retry') {
      if (!retrySeen.has(event.workOrderId)) {
        retrySeen.add(event.workOrderId)
        emit(`  ↳ [${label}] ↻ 上游重试中\n`)
      }
      return
    }
    // text / thinking: 首次输出状态行，之后静默——避免 deltas 计数刷屏
    if (!textSeen.has(event.workOrderId)) {
      textSeen.add(event.workOrderId)
      const glyph = event.kind === 'thinking' ? '思考中' : '写作中'
      emit(`  ↳ [${label}] ✎ ${glyph}\n`)
    }
  }
}
