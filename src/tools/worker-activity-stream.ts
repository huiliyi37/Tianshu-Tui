import type { WorkerActivityEvent } from '../agent/coordinator.js'
import type { DelegationActivity } from './types.js'

/** Shorten a work order id to a human label: "wo_team:T1" → "T1". */
export function shortOrderLabel(workOrderId: string): string {
  const seg = workOrderId.split(':').pop() ?? workOrderId
  return seg.replace(/^wo_/, '').slice(0, 12)
}

/**
 * One concise progress line for a worker activity event, for the structured
 * subagent fleet panel. Uses minimal English labels — tools already cycle
 * between types, so the label just records the current state without noise.
 */
export function activityProgressLine(event: WorkerActivityEvent): string {
  if (event.kind === 'tool_use') return `⚙ ${event.detail ? event.detail.slice(0, 60) : 'tool'}`
  if (event.kind === 'tool_result') return `✓ ${event.detail ? event.detail.slice(0, 50) : 'done'}`
  if (event.kind === 'thinking') return 'thinking'
  if (event.kind === 'turn') return ''
  return 'writing'
}

/**
 * 共享的 WorkerActivityEvent → DelegationActivity 映射器（delegate_task /
 * delegate_batch / team_orchestrate 三处委派工具复用）。
 *
 * 在事件流上做 per-worker 计数聚合（CC AgentProgress 对标）：
 * - tool_use 事件累计工具调用次数
 * - turn 事件携带累计 token 总数（worker 每 turn 结束上报一次）
 * 每条 running 事件都带上最新计数，读模型（FleetRegistry / 桌面面板）只做归约。
 */
export function createDelegationActivityMapper(
  parentToolId: string,
  onWorkerActivity: (activity: DelegationActivity) => void,
): (event: WorkerActivityEvent) => void {
  const counters = new Map<string, { toolUseCount: number; tokenCount: number }>()

  return (event: WorkerActivityEvent) => {
    let c = counters.get(event.workOrderId)
    if (!c) {
      c = { toolUseCount: 0, tokenCount: 0 }
      counters.set(event.workOrderId, c)
    }
    if (event.kind === 'tool_use') c.toolUseCount += 1
    if (event.kind === 'turn') {
      const n = Number(event.detail)
      if (Number.isFinite(n) && n > c.tokenCount) c.tokenCount = n
    }
    const line = activityProgressLine(event)
    onWorkerActivity({
      workOrderId: event.workOrderId,
      parentToolId,
      profile: event.profile,
      authority: event.authority,
      status: 'running',
      progressLine: line || undefined,
      toolUseCount: c.toolUseCount,
      tokenCount: c.tokenCount > 0 ? c.tokenCount : undefined,
      eventKind: event.kind,
      eventDetail: event.detail,
    })
  }
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

  return (event: WorkerActivityEvent) => {
    if (event.kind === 'turn') return  // 计数心跳，不产生文本行
    const label = `${shortOrderLabel(event.workOrderId)}·${event.profile}`
    if (event.kind === 'tool_use') {
      const toolDetail = event.detail ? ` ${event.detail.slice(0, 60)}` : ''
      emit(`  ↳ [${label}] ⚙${toolDetail}\n`)
      return
    }
    if (event.kind === 'tool_result') {
      const resultHint = event.detail ? ` (${event.detail.slice(0, 40)})` : ''
      emit(`  ↳ [${label}] ✓ 完成${resultHint}\n`)
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
