/**
 * MergeQueue — 有序合并队列
 *
 * Worker 完成后，diff 进入有序合并队列。
 * 按 conflict level 排序：Green 优先，Yellow 次之，Orange 最后。
 * Red 不入队，直接 escalate。
 */

import type { ConflictLevel } from './conflict-gradient.js'
import { conflictLevelValue } from './conflict-gradient.js'

// ─── Types ────────────────────────────────────────────────

export interface MergeQueueEntry {
  /** Worker ID */
  workerId: string
  /** Worker 分支名 */
  branch: string
  /** Diff 内容 */
  diff: string
  /** 修改的文件列表 */
  changedFiles: string[]
  /** 冲突级别 */
  conflictLevel: ConflictLevel
  /** 入队时间 */
  enqueuedAt: number
  /** 优先级（数值越高越优先） */
  priority: number
}

export type MergeQueueEvent =
  | { type: 'enqueued'; entry: MergeQueueEntry }
  | { type: 'dequeued'; entry: MergeQueueEntry }
  | { type: 'removed'; workerId: string }

export type MergeQueueStatus = 'pending' | 'merging' | 'merged' | 'escalated' | 'failed'

export interface MergeQueueEntryStatus {
  entry: MergeQueueEntry
  status: MergeQueueStatus
}

// ─── Queue ────────────────────────────────────────────────

const MAX_QUEUE_SIZE = 50

export class MergeQueue {
  private queue: MergeQueueEntry[] = []
  private statusMap: Map<string, MergeQueueStatus> = new Map()
  private completedFiles: string[] = []
  private listeners: Array<(event: MergeQueueEvent) => void> = []

  constructor(private readonly maxSize = MAX_QUEUE_SIZE) {}

  /** 注册事件监听 */
  on(listener: (event: MergeQueueEvent) => void): () => void {
    this.listeners.push(listener)
    return () => { this.listeners = this.listeners.filter(l => l !== listener) }
  }

  private emit(event: MergeQueueEvent): void {
    for (const l of this.listeners) l(event)
  }

  /**
   * 入队
   *
   * Red 级别不入队（应该直接 escalate）。
   * 按 conflict level 和 priority 排序。
   */
  enqueue(entry: MergeQueueEntry): boolean {
    // Red 级别直接拒绝
    if (entry.conflictLevel === 'red') return false

    if (this.queue.length >= this.maxSize) return false

    // 检查是否已存在
    if (this.queue.some(e => e.workerId === entry.workerId)) return false

    this.queue.push(entry)
    this.statusMap.set(entry.workerId, 'pending')
    this.sort()
    this.emit({ type: 'enqueued', entry })
    return true
  }

  /**
   * 取出下一个待合并的 entry
   *
   * 绿优先，黄次之，橙最后。同级别按 priority 降序，同 priority 按入队时间升序。
   */
  dequeue(): MergeQueueEntry | undefined {
    const entry = this.queue.find(e => this.statusMap.get(e.workerId) === 'pending')
    if (!entry) return undefined

    this.statusMap.set(entry.workerId, 'merging')
    this.emit({ type: 'dequeued', entry })
    return entry
  }

  /** 标记为已合并 */
  markMerged(workerId: string, appliedFiles: string[]): void {
    this.statusMap.set(workerId, 'merged')
    this.completedFiles.push(...appliedFiles)
    this.removeFromQueue(workerId)
  }

  /** 标记为已升级 */
  markEscalated(workerId: string): void {
    this.statusMap.set(workerId, 'escalated')
    this.removeFromQueue(workerId)
  }

  /** 标记为失败 */
  markFailed(workerId: string): void {
    this.statusMap.set(workerId, 'failed')
    this.removeFromQueue(workerId)
  }

  /** 获取已合并的文件列表 */
  getCompletedFiles(): string[] {
    return [...this.completedFiles]
  }

  /** 获取队列中所有 entry */
  getPending(): MergeQueueEntry[] {
    return this.queue.filter(e => this.statusMap.get(e.workerId) === 'pending')
  }

  /** 获取所有 entry 状态 */
  getAll(): MergeQueueEntryStatus[] {
    return this.queue.map(entry => ({
      entry,
      status: this.statusMap.get(entry.workerId) ?? 'pending',
    }))
  }

  /** 队列长度 */
  get size(): number {
    return this.queue.length
  }

  /** 是否为空 */
  get isEmpty(): boolean {
    return this.queue.length === 0
  }

  /** 移除指定 worker */
  remove(workerId: string): boolean {
    const existed = this.queue.some(e => e.workerId === workerId)
    this.removeFromQueue(workerId)
    this.statusMap.delete(workerId)
    if (existed) this.emit({ type: 'removed', workerId })
    return existed
  }

  private removeFromQueue(workerId: string): void {
    this.queue = this.queue.filter(e => e.workerId !== workerId)
  }

  /**
   * 排序规则：
   * 1. Conflict level 升序（green < yellow < orange）
   * 2. Priority 降序
   * 3. 入队时间升序（FIFO）
   */
  private sort(): void {
    this.queue.sort((a, b) => {
      const levelDiff = conflictLevelValue(a.conflictLevel) - conflictLevelValue(b.conflictLevel)
      if (levelDiff !== 0) return levelDiff

      const prioDiff = b.priority - a.priority
      if (prioDiff !== 0) return prioDiff

      return a.enqueuedAt - b.enqueuedAt
    })
  }
}
