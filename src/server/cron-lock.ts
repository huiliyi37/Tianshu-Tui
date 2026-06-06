/**
 * Cron Lock — PID 租约锁
 *
 * 保证多个天枢进程（各起 server）中恰好一个当 scheduler。
 *
 * 功能：
 * 1. O_EXCL 原子创建 .rivet/scheduled_tasks.lock
 * 2. PID 存活探测：ps -p <pid> -o state= | grep -v Z（避免 zombie 盲区）
 * 3. 陈旧锁回收（owner PID 不存在 → 接管）
 * 4. 退出清理（正常退出删锁）
 *
 * 部署假设：
 * - 锁仅在多进程各起 server 时有效
 * - 单 daemon 进程则锁 YAGNI —— scheduler 是进程内单例
 * - MVP 可降级为单进程无锁调度
 */

import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { isMainThread } from 'node:worker_threads'

// ─── Types ────────────────────────────────────────────────────

export interface LockInfo {
  pid: number
  acquiredAt: string
  hostname: string
}

export interface CronLockConfig {
  /** 锁文件路径 */
  lockPath?: string
  /** PID 存活检查间隔（毫秒） */
  healthCheckIntervalMs?: number
}

export type LockState =
  | { status: 'acquired'; info: LockInfo }
  | { status: 'contended'; owner: LockInfo }
  | { status: 'stale_recovered'; previousOwner: LockInfo; info: LockInfo }
  | { status: 'error'; reason: string }

// ─── Constants ────────────────────────────────────────────────

const DEFAULT_LOCK_PATH = '.rivet/scheduled_tasks.lock'
const DEFAULT_HEALTH_CHECK_MS = 10_000

// ─── PID Liveness ─────────────────────────────────────────────

/**
 * 检查 PID 是否存活（排除 zombie）。
 * macOS/Linux: ps -p <pid> -o state= | grep -v Z
 */
export function isPidAlive(pid: number): boolean {
  try {
    const output = execSync(`ps -p ${pid} -o state= 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 2000,
    })
    const state = output.trim()
    // 空输出 → 进程不存在；Z → zombie
    return state.length > 0 && !state.includes('Z')
  } catch {
    return false
  }
}

// ─── Lock File Operations ─────────────────────────────────────

function readLockFile(path: string): LockInfo | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as LockInfo
  } catch {
    return null
  }
}

function writeLockFile(path: string, info: LockInfo): void {
  writeFileSync(path, JSON.stringify(info, null, 2), 'utf-8')
}

/** O_EXCL 创建锁文件。成功返回 fd，失败返回 null */
function createLockFileExclusive(path: string): number | null {
  try {
    // O_EXCL | O_CREAT | O_WRONLY
    const fd = openSync(path, 'wx')
    return fd
  } catch {
    return null
  }
}

// ─── Cron Lock ────────────────────────────────────────────────

export class CronLock {
  private lockPath: string
  private healthCheckIntervalMs: number
  private state: LockState | null = null
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: CronLockConfig) {
    this.lockPath = config?.lockPath ?? DEFAULT_LOCK_PATH
    this.healthCheckIntervalMs = config?.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_MS
  }

  /** 尝试获取锁。返回锁状态 */
  acquire(): LockState {
    const fd = createLockFileExclusive(this.lockPath)

    if (fd !== null) {
      // 成功创建 → 获得锁
      const info: LockInfo = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        hostname: this.getHostname(),
      }
      writeLockFile(this.lockPath, info)
      closeSync(fd)
      this.state = { status: 'acquired', info }
      this.startHealthCheck()
      return this.state
    }

    // 锁文件已存在 → 检查 owner
    const owner = readLockFile(this.lockPath)
    if (!owner) {
      // 锁文件损坏 → 清理后重试
      this.forceRelease()
      return this.acquire()
    }

    // 检查 owner PID 是否存活
    if (owner.pid === process.pid) {
      // 自己已持有锁（可能是重启恢复）
      this.state = { status: 'acquired', info: owner }
      this.startHealthCheck()
      return this.state
    }

    if (!isPidAlive(owner.pid)) {
      // owner 已死 → 陈旧锁回收
      const newInfo: LockInfo = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        hostname: this.getHostname(),
      }
      writeLockFile(this.lockPath, newInfo)
      this.state = { status: 'stale_recovered', previousOwner: owner, info: newInfo }
      this.startHealthCheck()
      return this.state
    }

    // owner 存活 → 锁被占用
    this.state = { status: 'contended', owner }
    return this.state
  }

  /** 释放锁 */
  release(): void {
    this.stopHealthCheck()
    try {
      if (existsSync(this.lockPath)) {
        const owner = readLockFile(this.lockPath)
        if (owner?.pid === process.pid) {
          unlinkSync(this.lockPath)
        }
      }
    } catch {
      // 清理尽力而为
    }
    this.state = null
  }

  /** 强制释放锁（不论 owner） */
  forceRelease(): void {
    this.stopHealthCheck()
    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath)
      }
    } catch {
      // 清理尽力而为
    }
    this.state = null
  }

  /** 当前锁状态 */
  getState(): LockState | null {
    return this.state
  }

  /** 是否持有锁 */
  isOwner(): boolean {
    return this.state?.status === 'acquired' || this.state?.status === 'stale_recovered'
  }

  // ─── Internal ──────────────────────────────────────────────

  private getHostname(): string {
    try {
      return execSync('hostname', { encoding: 'utf-8', timeout: 1000 }).trim()
    } catch {
      return 'unknown'
    }
  }

  private startHealthCheck(): void {
    this.stopHealthCheck()
    // 仅主线程运行 health check（worker threads 不需要）
    if (!isMainThread) return
    this.healthCheckTimer = setInterval(() => {
      this.checkHealth()
    }, this.healthCheckIntervalMs)
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  private checkHealth(): void {
    // 验证锁文件仍归自己所有
    const owner = readLockFile(this.lockPath)
    if (!owner || owner.pid !== process.pid) {
      // 锁被意外篡改/丢失 → 标记 contended
      this.state = { status: 'contended', owner: owner ?? { pid: -1, acquiredAt: '', hostname: '' } }
    }
  }
}
