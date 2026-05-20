import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, openSync, closeSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'

export interface LWTGuardConfig {
  /** Directory for the alive marker file */
  stateDir: string
}

const ALIVE_FILE = 'agent.alive'
const LOCK_FILE = 'agent.lock'

export interface AliveMarker {
  sessionId: string
  pid: number
  startedAt: string
}

export class LWTGuard {
  private alivePath: string
  private lockPath: string
  private registered = false

  constructor(private config: LWTGuardConfig) {
    mkdirSync(config.stateDir, { recursive: true })
    this.alivePath = join(config.stateDir, ALIVE_FILE)
    this.lockPath = join(config.stateDir, LOCK_FILE)
  }

  /**
   * 检查上次是否异常退出
   * @returns 崩溃的会话 ID，或 null（正常退出）
   */
  checkPreviousCrash(): string | null {
    if (!existsSync(this.alivePath)) return null

    try {
      const data = JSON.parse(readFileSync(this.alivePath, 'utf-8')) as AliveMarker

      // 检查进程是否仍在运行
      if (this.isProcessRunning(data.pid)) {
        // 另一个实例正在运行，不是崩溃
        return null
      }

      return data.sessionId || null
    } catch {
      // 损坏的 alive 文件 — 视为潜在崩溃
      return null
    }
  }

  /**
   * 获取文件锁（防止多实例竞争）
   * 使用原子操作 O_CREAT|O_EXCL 避免 TOCTOU 竞态条件
   * @returns 是否成功获取锁
   */
  acquireLock(): boolean {
    // 检查锁文件是否已存在（可能是死锁）
    if (existsSync(this.lockPath)) {
      try {
        const data = readFileSync(this.lockPath, 'utf-8')
        const pid = parseInt(data, 10)
        if (pid && !this.isProcessRunning(pid)) {
          // 死锁：进程已退出但锁文件未清理
          unlinkSync(this.lockPath)
        } else {
          // 锁被其他进程持有
          return false
        }
      } catch {
        try { unlinkSync(this.lockPath) } catch { /* ignore */ }
      }
    }

    // 原子创建：O_CREAT|O_EXCL 在文件已存在时会失败。
    // Write the PID through the same fd to avoid a create→close→write TOCTOU gap.
    let fd: number | null = null
    try {
      fd = openSync(this.lockPath, 'wx') // wx = O_CREAT|O_EXCL
      writeSync(fd, String(process.pid))
      return true
    } catch {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
        try { unlinkSync(this.lockPath) } catch { /* ignore */ }
      }
      return false
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
    }
  }

  /**
   * 释放文件锁
   */
  releaseLock(): void {
    try {
      unlinkSync(this.lockPath)
    } catch {
      // ignore
    }
  }

  /**
   * 注册 alive 标记
   * @param sessionId - 当前会话 ID
   */
  register(sessionId: string): void {
    if (this.registered) return
    this.registered = true

    const marker: AliveMarker = {
      sessionId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }

    writeFileAtomicSync(this.alivePath, JSON.stringify(marker))

    // 注册退出处理器
    const clear = () => this.clear()
    process.on('exit', clear)
    process.on('SIGINT', () => { this.clear(); process.exit(0) })
    process.on('SIGTERM', () => { this.clear(); process.exit(0) })
  }

  /**
   * 清除 alive 标记（正常退出）
   */
  clear(): void {
    try { unlinkSync(this.alivePath) } catch { /* already cleared */ }
    this.registered = false
  }

  /**
   * 检查进程是否仍在运行
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0) // 0 = 不发送信号，只检查进程是否存在
      return true
    } catch {
      return false
    }
  }
}
