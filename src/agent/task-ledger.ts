/**
 * TaskLedger — 任务事件账本 (B1-1)
 *
 * 记录当前任务的所有文件读写、验证、git 操作等事件。
 * 作为归属星轨的底层数据源，驱动 OwnershipLedger、VerificationAttribution、
 * DeliveryGate v2 和 deliver_task 工具。
 *
 * HEARTH 兼容：taskId 可映射到 session 的 cycle_open，getSummary() 可沉积为
 * stigmergy pheromone 供 Songline 消费。
 *
 * Songline 兼容：事件流可被 obligation engine 读取，判断任务义务履行状态。
 *
 * @module task-ledger
 * @task B1-1
 */

export type TaskLedgerEventType =
  | 'file_read'
  | 'file_write'
  | 'tool_exec'
  | 'verification'
  | 'git_action'
  | 'undo_action'

export interface TaskLedgerEvent {
  type: TaskLedgerEventType
  timestamp: number
  /** File path for file_read, file_write, git_action, undo_action */
  path?: string
  /** Command string for verification events */
  command?: string
  /** Verification status */
  status?: 'passed' | 'failed' | 'blocked'
  /** Tool name for tool_exec events */
  tool?: string
  /**
   * Arbitrary context for extension.
   * Verification events may store structured metadata mirrored from
   * VerificationMetadata: scope, exitCode, passed, failed, skipped,
   * durationMs, resolvedCommand, targetFiles, recommendedCommand,
   * failureKind.
   */
  meta?: Record<string, unknown>
}

export type DeliveryVerificationLevel =
  | 'verified'
  | 'failed'
  | 'blocked'
  | 'unverified'
  /** External verification blocked — deliverable with caveat (maps to HEARTH YELLOW) */
  | 'external_blocked'

export interface DeliveryReadiness {
  canDeliver: boolean
  level: DeliveryVerificationLevel
  reason?: string
  /** Number of owned files requiring verification */
  unverifiedFileCount?: number
}

export interface TaskLedgerSummary {
  taskId: string
  eventCount: number
  readFileCount: number
  writeFileCount: number
  ownedFileCount: number
  verificationCount: number
  verificationStatus: DeliveryVerificationLevel
  /** Timestamp range for temporal queries */
  firstEventAt: number | null
  lastEventAt: number | null
}

export interface TaskLedger {
  record(event: Omit<TaskLedgerEvent, 'timestamp'>): void
  getEvents(): ReadonlyArray<TaskLedgerEvent>
  /** Remove all events associated with a specific path (e.g. a discarded plan draft). */
  removeEventsByPath(path: string): void
  getOwnedFiles(): string[]
  getVerifications(): ReadonlyArray<TaskLedgerEvent>
  getVerificationStatus(): DeliveryVerificationLevel
  getDeliveryReadiness(): DeliveryReadiness
  getSummary(): TaskLedgerSummary
  getTaskId(): string
  reset(): void
}

export function createTaskLedger(opts: { taskId: string }): TaskLedger {
  const events: TaskLedgerEvent[] = []

  function record(event: Omit<TaskLedgerEvent, 'timestamp'>): void {
    events.push({ ...event, timestamp: Date.now() })
  }

  function getEvents(): ReadonlyArray<TaskLedgerEvent> {
    return events
  }

  function removeEventsByPath(path: string): void {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.path === path) {
        events.splice(i, 1)
      }
    }
  }

  function getOwnedFiles(): string[] {
    const files = new Set<string>()
    for (const e of events) {
      if ((e.type === 'file_write' || e.type === 'git_action') && e.path) {
        files.add(e.path)
      }
    }
    return [...files].sort()
  }

  function getVerifications(): ReadonlyArray<TaskLedgerEvent> {
    return events.filter(e => e.type === 'verification')
  }

  function getVerificationStatus(): DeliveryVerificationLevel {
    const verifications = getVerifications()
    if (verifications.length === 0) {
      const writes = events.filter(e => e.type === 'file_write')
      return writes.length === 0 ? 'verified' : 'unverified'
    }

    const hasFailed = verifications.some(v => v.status === 'failed')
    if (hasFailed) return 'failed'

    const hasBlocked = verifications.some(v => v.status === 'blocked')
    if (hasBlocked) return 'blocked'

    const allPassed = verifications.every(v => v.status === 'passed')
    if (allPassed) return 'verified'

    return 'unverified'
  }

  function getDeliveryReadiness(): DeliveryReadiness {
    const status = getVerificationStatus()
    const ownedFiles = getOwnedFiles()

    switch (status) {
      case 'verified':
        return { canDeliver: true, level: 'verified' }

      case 'failed': {
        const failedVerifications = getVerifications().filter(v => v.status === 'failed')
        const cmds = failedVerifications.map(v => v.command).filter(Boolean).join(', ')
        return {
          canDeliver: false,
          level: 'failed',
          reason: `Verification failed: ${cmds}. Fix failures before delivery.`,
          unverifiedFileCount: ownedFiles.length,
        }
      }

      case 'blocked': {
        const blockedVerifications = getVerifications().filter(v => v.status === 'blocked')
        const cmds = blockedVerifications.map(v => v.command).filter(Boolean).join(', ')
        return {
          canDeliver: true,
          level: 'external_blocked',
          reason: `Verification blocked by external factors: ${cmds}. Owned changes are unverified.`,
          unverifiedFileCount: ownedFiles.length,
        }
      }

      case 'unverified':
        return {
          canDeliver: false,
          level: 'unverified',
          reason: `${ownedFiles.length} owned file(s) modified, still unverified. Run verification before delivery.`,
          unverifiedFileCount: ownedFiles.length,
        }

      default:
        return { canDeliver: false, level: 'unverified', reason: 'Unknown verification state.' }
    }
  }

  function getSummary(): TaskLedgerSummary {
    const verifications = getVerifications()
    const reads = events.filter(e => e.type === 'file_read').length
    const writes = events.filter(e => e.type === 'file_write').length

    return {
      taskId: opts.taskId,
      eventCount: events.length,
      readFileCount: reads,
      writeFileCount: writes,
      ownedFileCount: getOwnedFiles().length,
      verificationCount: verifications.length,
      verificationStatus: getVerificationStatus(),
      firstEventAt: events.length > 0 ? (events[0]?.timestamp ?? null) : null,
      lastEventAt: events.length > 0 ? (events[events.length - 1]?.timestamp ?? null) : null,
    }
  }

  function getTaskId(): string {
    return opts.taskId
  }

  function reset(): void {
    events.length = 0
  }

  return {
    record,
    getEvents,
    removeEventsByPath,
    getOwnedFiles,
    getVerifications,
    getVerificationStatus,
    getDeliveryReadiness,
    getSummary,
    getTaskId,
    reset,
  }
}
