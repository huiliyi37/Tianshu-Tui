/**
 * CollaborationProtocol — 多 Session 协作协议门面
 *
 * 统一入口，整合语义锁、冲突梯度、死锁检测、合并协议、合并队列。
 *
 * 使用方式：
 * 1. coordinator 创建 CollaborationProtocol 实例
 * 2. dispatch worker 前调用 acquireLock() 获取语义锁
 * 3. worker 完成后调用 onWorkerComplete() 合并结果
 * 4. 主循环中定期调用 heartbeat() 和 sweep()
 */

import { SemanticLockManager, type LockIntent, type AcquireResult, type SemanticLock } from './semantic-lock.js'
import { detectConflictGradient, assessIntentConflict, type ConflictLevel, type ConflictAssessment } from './conflict-gradient.js'
import { detectAndResolve, type DeadlockReport } from './deadlock-detector.js'
import { executeMergeProtocol, type MergeInput, type MergeResult } from './merge-protocol.js'
import { MergeQueue, type MergeQueueEntry } from './merge-queue.js'

// ─── Types ────────────────────────────────────────────────

export interface CollaborationConfig {
  /** 默认锁 TTL（毫秒） */
  defaultLockTtl?: number
  /** 心跳间隔（毫秒） */
  heartbeatInterval?: number
  /** 合并队列最大大小 */
  maxQueueSize?: number
}

export interface WorkerCompletion {
  workerId: string
  workerBranch: string
  workerPath: string
  changedFiles: string[]
  diff: string
}

export type CollaborationEvent =
  | { type: 'lock_acquired'; sessionId: string; intent: LockIntent }
  | { type: 'lock_denied'; sessionId: string; intent: LockIntent; reason: string }
  | { type: 'conflict_detected'; assessment: ConflictAssessment }
  | { type: 'deadlock_detected'; report: DeadlockReport }
  | { type: 'merge_completed'; result: MergeResult }
  | { type: 'merge_escalated'; result: MergeResult }
  | { type: 'locks_swept'; count: number }

// ─── Protocol ─────────────────────────────────────────────

export class CollaborationProtocol {
  readonly lockManager: SemanticLockManager
  readonly mergeQueue: MergeQueue
  private listeners: Array<(event: CollaborationEvent) => void> = []
  private mergedFiles: string[] = []

  constructor(private readonly config: CollaborationConfig = {}) {
    this.lockManager = new SemanticLockManager({
      defaultTtl: config.defaultLockTtl,
      heartbeatInterval: config.heartbeatInterval,
    })
    this.mergeQueue = new MergeQueue(config.maxQueueSize)
  }

  /** 注册事件监听 */
  on(listener: (event: CollaborationEvent) => void): () => void {
    this.listeners.push(listener)
    return () => { this.listeners = this.listeners.filter(l => l !== listener) }
  }

  private emit(event: CollaborationEvent): void {
    for (const l of this.listeners) l(event)
  }

  // ─── Lock Operations ──────────────────────────────

  /**
   * 获取语义锁
   *
   * 1. 检查是否有排他冲突
   * 2. 如果有，检测死锁
   * 3. 如果无死锁，返回冲突信息
   * 4. 如果无冲突，获取锁
   */
  acquireLock(sessionId: string, intent: LockIntent): AcquireResult {
    const result = this.lockManager.acquire(sessionId, intent)

    if (result.acquired) {
      this.emit({ type: 'lock_acquired', sessionId, intent })
      return result
    }

    this.emit({ type: 'lock_denied', sessionId, intent, reason: `Conflicting locks: ${result.conflictingFiles.join(', ')}` })
    return result
  }

  /**
   * 获取多个语义锁（原子操作）
   */
  acquireAllLocks(sessionId: string, intents: LockIntent[]): AcquireResult {
    return this.lockManager.acquireAll(sessionId, intents)
  }

  /** 释放 session 的所有锁 */
  releaseLocks(sessionId: string): void {
    this.lockManager.releaseAll(sessionId)
  }

  /** 获取 session 的锁 */
  getSessionLocks(sessionId: string): SemanticLock[] {
    return this.lockManager.getSessionLocks(sessionId)
  }

  // ─── Conflict Detection ───────────────────────────

  /**
   * 评估一个新 intent 与现有锁的冲突
   */
  assessConflict(intent: LockIntent, sessionId: string): ConflictAssessment {
    const assessment = assessIntentConflict(intent, this.lockManager.getAllLocks(), sessionId)

    if (assessment.level !== 'green') {
      this.emit({ type: 'conflict_detected', assessment })
    }

    return assessment
  }

  /**
   * 检测两个 session 的冲突
   */
  detectConflict(sessionA: string, sessionB: string): ConflictAssessment {
    const locksA = this.lockManager.getSessionLocks(sessionA)
    const locksB = this.lockManager.getSessionLocks(sessionB)
    return detectConflictGradient(locksA, locksB)
  }

  // ─── Deadlock Detection ───────────────────────────

  /**
   * 检测死锁
   *
   * 给定等待队列，检测是否存在死锁环
   */
  detectDeadlock(
    waiters: Array<{ sessionId: string; intent: LockIntent }>,
  ): DeadlockReport | null {
    const report = detectAndResolve(waiters, this.lockManager.getAllLocks())
    if (report) {
      this.emit({ type: 'deadlock_detected', report })
    }
    return report
  }

  // ─── Merge Operations ─────────────────────────────

  /**
   * Worker 完成后处理
   *
   * 1. 评估冲突级别
   * 2. 入合并队列
   * 3. 执行合并（如果可以）
   */
  async onWorkerComplete(
    completion: WorkerCompletion,
    baseBranch: string,
    basePath: string,
  ): Promise<MergeResult> {
    // 评估冲突
    const conflict = this.assessConflict(
      {
        operation: 'edit',
        files: completion.changedFiles,
        description: `Worker ${completion.workerId} changes`,
      },
      completion.workerId,
    )

    if (conflict.level === 'red') {
      // 直接 escalate
      const result: MergeResult = {
        strategy: 'escalate',
        success: false,
        appliedFiles: [],
        conflictedFiles: completion.changedFiles,
        report: `Red conflict detected: ${conflict.detail}`,
        log: ['Red conflict — escalating immediately'],
      }
      this.emit({ type: 'merge_escalated', result })
      return result
    }

    // 入队
    const entry: MergeQueueEntry = {
      workerId: completion.workerId,
      branch: completion.workerBranch,
      diff: completion.diff,
      changedFiles: completion.changedFiles,
      conflictLevel: conflict.level as ConflictLevel,
      enqueuedAt: Date.now(),
      priority: conflict.level === 'green' ? 10 : conflict.level === 'yellow' ? 5 : 1,
    }

    this.mergeQueue.enqueue(entry)

    // 尝试合并
    const toMerge = this.mergeQueue.dequeue()
    if (!toMerge) {
      return {
        strategy: 'auto_cherry_pick',
        success: false,
        appliedFiles: [],
        conflictedFiles: [],
        log: ['Queued but no entry available for merge'],
      }
    }

    const mergeInput: MergeInput = {
      workerBranch: toMerge.branch,
      workerPath: completion.workerPath,
      baseBranch,
      basePath,
      changedFiles: toMerge.changedFiles,
      previouslyMergedFiles: this.mergedFiles,
    }

    const result = await executeMergeProtocol(mergeInput)

    if (result.success) {
      this.mergeQueue.markMerged(toMerge.workerId, result.appliedFiles)
      this.mergedFiles.push(...result.appliedFiles)
      this.emit({ type: 'merge_completed', result })
    } else if (result.strategy === 'escalate') {
      this.mergeQueue.markEscalated(toMerge.workerId)
      this.emit({ type: 'merge_escalated', result })
    } else {
      this.mergeQueue.markFailed(toMerge.workerId)
    }

    // 释放 worker 的锁
    this.releaseLocks(completion.workerId)

    return result
  }

  // ─── Lifecycle ────────────────────────────────────

  /** 心跳续期 */
  heartbeat(sessionId: string): void {
    this.lockManager.heartbeat(sessionId)
  }

  /** 清除过期锁 */
  sweep(): number {
    const count = this.lockManager.sweepExpired()
    if (count > 0) {
      this.emit({ type: 'locks_swept', count })
    }
    return count
  }

  /** 启动后台任务 */
  start(): void {
    this.lockManager.startSweep()
  }

  /** 停止后台任务 */
  stop(): void {
    this.lockManager.stopSweep()
  }

  /** 获取协议状态摘要 */
  getStatus(): {
    activeLocks: number
    queueSize: number
    mergedFiles: number
  } {
    return {
      activeLocks: this.lockManager.getAllLocks().length,
      queueSize: this.mergeQueue.size,
      mergedFiles: this.mergedFiles.length,
    }
  }
}
