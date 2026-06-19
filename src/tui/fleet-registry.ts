/**
 * FleetRegistry — TUI 侧的并行子代理「舰队读模型」。
 *
 * 订阅工具流水线已有的结构化 `DelegationActivity` 事件流（T4，原本只有桌面
 * session-manager 消费），在 T9 侧聚合成 per-worker / per-group 的实时快照，
 * 供 /tasks overlay、内联 worker 面板与 TeamPanel 运行态读取。
 *
 * 纯读投影：只做归约与查询，不做调度、不发事件。coordinator 的队列与
 * liveness 是 delegateBatch 栈内私有对象，TUI 拿不到；本读模型完全由事件
 * 流驱动，无需触碰 coordinator 内部。
 */

import type { DelegationActivity } from '../tools/types.js'
import { shortOrderLabel } from '../tools/worker-activity-stream.js'
import type { WorkerPanelStatus } from './worker-panel-model.js'

export interface FleetWorkerView {
  /** Work order id（稳定的 per-worker 标识，区别于 spawning tool id）。 */
  workerId: string
  /** 人类友好短标签，例如 "wo_team:T1" → "T1"。 */
  shortLabel: string
  /** 派生该 worker 的委派工具调用 id（委派树父节点）。 */
  parentToolId: string
  profile: string
  /** 星域 id（星名来源），从 DelegationActivity.authority 透传。 */
  authority?: string
  /** 原始委派状态。 */
  status: DelegationActivity['status']
  /** WorkerPanel 兼容状态（glyph / auto-collapse 用）。 */
  panelStatus: WorkerPanelStatus
  /** 是否已到达终态。 */
  terminal: boolean
  /** 最新运行活动行（running）或终态摘要。 */
  activity?: string
  /** 自首次观测起的毫秒数（快照时计算；终态后冻结）。 */
  elapsedMs: number
}

export interface FleetGroupProgress {
  total: number
  done: number
  failed: number
  running: number
}

interface FleetRecord {
  workerId: string
  parentToolId: string
  profile: string
  authority?: string
  status: DelegationActivity['status']
  terminal: boolean
  activity?: string
  startedAt: number
  updatedAt: number
}

const TERMINAL_STATUSES = new Set<DelegationActivity['status']>([
  'passed',
  'failed',
  'blocked',
  'escalated',
])

/** 把委派状态映射为 WorkerPanel 状态（blocked/escalated 归入 failed 显示）。 */
function panelStatusOf(status: DelegationActivity['status']): WorkerPanelStatus {
  if (status === 'running') return 'running'
  if (status === 'passed') return 'done'
  return 'failed'
}

export class FleetRegistry {
  private records = new Map<string, FleetRecord>()

  /**
   * 归约一条委派活动事件。
   * - 首见：stamp startedAt（用于 elapsed）。
   * - 复见：合并状态/活动行；profile 缺省时保留既有（终态事件常不带 profile）。
   */
  apply(activity: DelegationActivity, now: number = Date.now()): void {
    const terminal = TERMINAL_STATUSES.has(activity.status)
    const existing = this.records.get(activity.workOrderId)
    if (existing) {
      existing.status = activity.status
      existing.terminal = terminal
      existing.updatedAt = now
      if (activity.profile) existing.profile = activity.profile
      if (activity.authority) existing.authority = activity.authority
      if (activity.progressLine) existing.activity = activity.progressLine
      return
    }
    this.records.set(activity.workOrderId, {
      workerId: activity.workOrderId,
      parentToolId: activity.parentToolId,
      profile: activity.profile ?? 'worker',
      authority: activity.authority,
      status: activity.status,
      terminal,
      activity: activity.progressLine,
      startedAt: now,
      updatedAt: now,
    })
  }

  private toView(r: FleetRecord, now: number): FleetWorkerView {
    return {
      workerId: r.workerId,
      shortLabel: shortOrderLabel(r.workerId),
      parentToolId: r.parentToolId,
      profile: r.profile,
      authority: r.authority,
      status: r.status,
      panelStatus: panelStatusOf(r.status),
      terminal: r.terminal,
      activity: r.activity,
      elapsedMs: Math.max(0, (r.terminal ? r.updatedAt : now) - r.startedAt),
    }
  }

  /** 全部 worker，按首见时间升序。 */
  getWorkers(now: number = Date.now()): FleetWorkerView[] {
    return [...this.records.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(r => this.toView(r, now))
  }

  /** 仍在跑（未终态）的 worker，按首见时间升序。 */
  getActiveWorkers(now: number = Date.now()): FleetWorkerView[] {
    return [...this.records.values()]
      .filter(r => !r.terminal)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(r => this.toView(r, now))
  }

  /** 某委派工具组的完成进度（done/total 由组内 worker 计数派生）。 */
  getGroupProgress(parentToolId: string): FleetGroupProgress {
    const group = [...this.records.values()].filter(r => r.parentToolId === parentToolId)
    return {
      total: group.length,
      done: group.filter(r => r.status === 'passed').length,
      failed: group.filter(r => r.terminal && r.status !== 'passed').length,
      running: group.filter(r => !r.terminal).length,
    }
  }

  /** 当前出现过的委派工具 id（保持首见顺序）。 */
  getParentToolIds(): string[] {
    const ids: string[] = []
    for (const r of this.records.values()) {
      if (!ids.includes(r.parentToolId)) ids.push(r.parentToolId)
    }
    return ids
  }

  /** 委派工具终态时清理该组所有 worker 记录。 */
  clearGroup(parentToolId: string): void {
    for (const [id, r] of this.records) {
      if (r.parentToolId === parentToolId) this.records.delete(id)
    }
  }

  get size(): number {
    return this.records.size
  }

  isEmpty(): boolean {
    return this.records.size === 0
  }

  /** 是否有任一 worker 仍在跑（auto-collapse 判据）。 */
  hasActive(): boolean {
    for (const r of this.records.values()) {
      if (!r.terminal) return true
    }
    return false
  }

  clear(): void {
    this.records.clear()
  }
}
