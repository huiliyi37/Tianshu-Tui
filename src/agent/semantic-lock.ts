/**
 * SemanticLock — 语义文件锁
 *
 * 不只是"我要编辑这个文件"，而是声明"我要在文件中做什么"。
 * 通过 intent 声明，实现比简单排他锁更智能的兼容性判断。
 *
 * 设计原则：
 * - 锁是 advisory 的，不强制阻止操作
 * - 锁有 TTL，心跳续期，僵尸自动收割
 * - 锁兼容矩阵决定两个操作是否可以并行
 */

// DomainArea from work-order: frontend | backend | prompt | tools | config | docs | tests
// Inlined to avoid pulling zod through the import chain (tsx module resolution issue)

/** 操作类型 */
export type LockOperation = 'edit' | 'create' | 'delete' | 'rename' | 'refactor'

/** 锁的完整声明 */
export interface LockIntent {
  /** 操作类型 */
  operation: LockOperation
  /** 受影响的文件列表（相对路径） */
  files: string[]
  /** 语义描述，如 "修改 AgentLoop 的 turn 处理逻辑" */
  description: string
  /** 预估影响区域 */
  domainHints?: string[] // e.g. 'frontend' | 'backend' | 'prompt' | 'tools' | 'config' | 'docs' | 'tests'
}

/** 运行时锁实例 */
export interface SemanticLock {
  /** 持有者 session ID */
  sessionId: string
  /** 锁声明 */
  intent: LockIntent
  /** 获取时间 (Date.now()) */
  acquiredAt: number
  /** 最近一次心跳时间 */
  lastHeartbeat: number
  /** 生存时间（毫秒） */
  ttl: number
}

/** 锁获取结果 */
export interface AcquireResult {
  acquired: boolean
  /** 如果失败，列出冲突的锁 */
  conflictingLocks: SemanticLock[]
  /** 冲突文件 */
  conflictingFiles: string[]
}

/** 锁兼容性级别 */
export type LockCompatibility = 'compatible' | 'conditional' | 'exclusive'

// ─── Compatibility Matrix ─────────────────────────────────

/**
 * 锁兼容矩阵
 *
 * compatible  → 可以并行
 * conditional → 需要进一步检查（触发冲突梯度检测）
 * exclusive   → 不可并行
 */
const COMPAT_MATRIX: Record<LockOperation, Record<LockOperation, LockCompatibility>> = {
  edit:     { edit: 'exclusive', create: 'compatible', delete: 'exclusive', rename: 'exclusive', refactor: 'conditional' },
  create:   { edit: 'compatible', create: 'compatible', delete: 'exclusive', rename: 'exclusive', refactor: 'compatible' },
  delete:   { edit: 'exclusive', create: 'exclusive', delete: 'exclusive', rename: 'exclusive', refactor: 'exclusive' },
  rename:   { edit: 'exclusive', create: 'exclusive', delete: 'exclusive', rename: 'exclusive', refactor: 'exclusive' },
  refactor: { edit: 'conditional', create: 'compatible', delete: 'exclusive', rename: 'exclusive', refactor: 'conditional' },
}

/**
 * 判断两个操作类型是否兼容
 */
export function getLockCompatibility(a: LockOperation, b: LockOperation): LockCompatibility {
  return COMPAT_MATRIX[a][b]
}

// ─── SemanticLockManager ──────────────────────────────────

const DEFAULT_TTL = 3_600_000 // 1 小时
const HEARTBEAT_INTERVAL = 30_000 // 30 秒

export interface SemanticLockManagerConfig {
  /** 默认 TTL（毫秒） */
  defaultTtl?: number
  /** 心跳间隔（毫秒） */
  heartbeatInterval?: number
}

/**
 * 语义锁管理器
 *
 * 管理所有活跃的语义锁。纯内存操作，不持久化（锁是临时的）。
 * 通过 heartbeat 续期，通过 TTL 过期回收。
 */
export class SemanticLockManager {
  private locks: Map<string, SemanticLock> = new Map()
  private readonly defaultTtl: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: SemanticLockManagerConfig) {
    this.defaultTtl = config?.defaultTtl ?? DEFAULT_TTL
  }

  /** 启动后台僵尸收割 */
  startSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepExpired(), HEARTBEAT_INTERVAL)
  }

  /** 停止后台收割 */
  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /**
   * 获取语义锁
   *
   * 检查所有文件是否与其他 session 的锁兼容。
   * 如果完全兼容或有条件兼容（conditional），返回 acquired=true。
   * 如果有排他冲突，返回 acquired=false 并列出冲突锁。
   */
  acquire(sessionId: string, intent: LockIntent, ttl?: number): AcquireResult {
    const conflictingLocks: SemanticLock[] = []
    const conflictingFiles: string[] = []

    for (const lock of this.locks.values()) {
      if (lock.sessionId === sessionId) continue // 自己的锁不冲突

      const fileOverlap = this.findFileOverlap(intent.files, lock.intent.files)
      if (fileOverlap.length === 0) continue

      const compat = getLockCompatibility(intent.operation, lock.intent.operation)
      if (compat === 'exclusive') {
        conflictingLocks.push(lock)
        conflictingFiles.push(...fileOverlap)
      }
      // conditional 和 compatible 都允许获取（conditional 会触发后续的冲突梯度检测）
    }

    if (conflictingLocks.length > 0) {
      return {
        acquired: false,
        conflictingLocks,
        conflictingFiles: [...new Set(conflictingFiles)],
      }
    }

    const now = Date.now()
    const lock: SemanticLock = {
      sessionId,
      intent,
      acquiredAt: now,
      lastHeartbeat: now,
      ttl: ttl ?? this.defaultTtl,
    }
    this.locks.set(`${sessionId}:${intent.operation}:${intent.files.join(',')}`, lock)

    return { acquired: true, conflictingLocks: [], conflictingFiles: [] }
  }

  /**
   * 获取同一 session 多个 intent 的锁
   * 原子操作：要么全部成功，要么全部失败
   */
  acquireAll(sessionId: string, intents: LockIntent[], ttl?: number): AcquireResult {
    // 先检查所有 intent 是否都可以获取
    const allConflicting: SemanticLock[] = []
    const allFiles: string[] = []

    for (const intent of intents) {
      const result = this.acquire(sessionId, intent, ttl)
      if (!result.acquired) {
        allConflicting.push(...result.conflictingLocks)
        allFiles.push(...result.conflictingFiles)
      }
    }

    if (allConflicting.length > 0) {
      // 部分已获取的锁需要回滚
      this.releaseAll(sessionId)
      return {
        acquired: false,
        conflictingLocks: [...new Set(allConflicting)],
        conflictingFiles: [...new Set(allFiles)],
      }
    }

    return { acquired: true, conflictingLocks: [], conflictingFiles: [] }
  }

  /** 释放 session 的所有锁 */
  releaseAll(sessionId: string): void {
    for (const [key, lock] of this.locks.entries()) {
      if (lock.sessionId === sessionId) {
        this.locks.delete(key)
      }
    }
  }

  /** 释放 session 特定 intent 的锁 */
  release(sessionId: string, intent: LockIntent): void {
    const key = `${sessionId}:${intent.operation}:${intent.files.join(',')}`
    this.locks.delete(key)
  }

  /** 心跳续期 */
  heartbeat(sessionId: string): void {
    const now = Date.now()
    for (const lock of this.locks.values()) {
      if (lock.sessionId === sessionId) {
        lock.lastHeartbeat = now
      }
    }
  }

  /** 获取 session 的所有活跃锁 */
  getSessionLocks(sessionId: string): SemanticLock[] {
    const result: SemanticLock[] = []
    for (const lock of this.locks.values()) {
      if (lock.sessionId === sessionId) {
        result.push(lock)
      }
    }
    return result
  }

  /** 获取所有活跃锁 */
  getAllLocks(): SemanticLock[] {
    return [...this.locks.values()]
  }

  /** 获取文件的当前锁 */
  getFileLocks(filePath: string): SemanticLock[] {
    const result: SemanticLock[] = []
    for (const lock of this.locks.values()) {
      if (lock.intent.files.includes(filePath)) {
        result.push(lock)
      }
    }
    return result
  }

  /** 检查文件是否被锁定（被其他 session） */
  isFileLocked(filePath: string, excludeSessionId?: string): boolean {
    for (const lock of this.locks.values()) {
      if (lock.sessionId === excludeSessionId) continue
      if (lock.intent.files.includes(filePath)) return true
    }
    return false
  }

  /** 清除过期锁（僵尸收割） */
  sweepExpired(): number {
    const now = Date.now()
    let swept = 0
    for (const [key, lock] of this.locks.entries()) {
      if (now - lock.lastHeartbeat > lock.ttl) {
        this.locks.delete(key)
        swept++
      }
    }
    return swept
  }

  /** 两个文件列表的交集 */
  private findFileOverlap(a: string[], b: string[]): string[] {
    const setB = new Set(b)
    return a.filter(f => setB.has(f))
  }
}
