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
/** Max activity log entries kept per worker (ring buffer). */
const ACTIVITY_LOG_MAX = 20


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
  /** Latest activity line (running) or terminal summary. */
  activity?: string
  /** Recent activity log entries (newest last, capped at ACTIVITY_LOG_MAX). */
  activityLog: string[]
  /** Self-observed ms since first observation (snapshot-time; frozen after terminal). */
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
  activityLog: string[]
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
  /** 终态 worker 归档区：clearGroup 后仍可被 detail pager 查询。 */
  private terminalRecords = new Map<string, FleetRecord>()

  /**
   * 归约一条委派活动事件。
   * - 首见：stamp startedAt（用于 elapsed）。
   * - 复见：合并状态/活动行；profile 缺省时保留既有（终态事件常不带 profile）。
   */
  apply(activity: DelegationActivity, now: number = Date.now()): void {
    const terminal = TERMINAL_STATUSES.has(activity.status)
    // 若之前在归档区被终态后重新收到 running，则移回 active（resume/重跑场景）
    const archived = this.terminalRecords.get(activity.workOrderId)
    if (archived && !terminal) {
      this.records.set(activity.workOrderId, archived)
      this.terminalRecords.delete(activity.workOrderId)
    }

    const existing = this.records.get(activity.workOrderId)

    // Maintain activity log ring buffer
    const log = existing?.activityLog ? [...existing.activityLog] : []
    if (activity.progressLine && activity.progressLine !== existing?.activity) {
      log.push(activity.progressLine)
      if (log.length > ACTIVITY_LOG_MAX) log.shift()
    }

    if (existing) {
      existing.status = activity.status
      existing.terminal = terminal
      existing.updatedAt = now
      existing.activityLog = log
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
      activityLog: log,
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
      activityLog: r.activityLog,
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

  /** 委派工具终态时把该组 worker 移入归档区，而不是删除。 */
  clearGroup(parentToolId: string): void {
    for (const [id, r] of this.records) {
      if (r.parentToolId === parentToolId) {
        this.records.delete(id)
        this.terminalRecords.set(id, r)
      }
    }
  }

  /** 按 id 查找 worker（active 优先，其次归档区）。 */
  getWorkerById(workerId: string, now: number = Date.now()): FleetWorkerView | undefined {
    const r = this.records.get(workerId) ?? this.terminalRecords.get(workerId)
    return r ? this.toView(r, now) : undefined
  }

  private allTerminalRecords(): FleetRecord[] {
    return [...this.records.values()].filter(r => r.terminal)
      .concat([...this.terminalRecords.values()])
  }

  /** 已终态 worker 列表（按首见时间升序）。 */
  getCompletedWorkers(now: number = Date.now()): FleetWorkerView[] {
    return this.allTerminalRecords()
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(r => this.toView(r, now))
  }

  /** 全部 worker（active + 归档），可选 filter。 */
  getAllWorkers(now: number = Date.now(), filter: 'active' | 'completed' | 'all' = 'all'): FleetWorkerView[] {
    const source: FleetRecord[] = []
    if (filter === 'active') {
      source.push(...[...this.records.values()].filter(r => !r.terminal))
    } else if (filter === 'completed') {
      source.push(...this.allTerminalRecords())
    } else {
      // all：union active records + terminal archive，按 id 去重
      const seen = new Set<string>()
      for (const r of this.records.values()) {
        seen.add(r.workerId)
        source.push(r)
      }
      for (const r of this.terminalRecords.values()) {
        if (!seen.has(r.workerId)) source.push(r)
      }
    }
    return source.sort((a, b) => a.startedAt - b.startedAt).map(r => this.toView(r, now))
  }

  get size(): number {
    return this.records.size
  }

  /** 已终态 worker 数量。 */
  completedSize(): number {
    return this.terminalRecords.size
  }

  isEmpty(): boolean {
    return this.records.size === 0 && this.terminalRecords.size === 0
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
    this.terminalRecords.clear()
  }
}
