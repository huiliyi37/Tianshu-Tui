/**
 * TaskRegistry — daemon 级任务注册表
 *
 * 拥有任务生命周期：pending → running → (completed | failed | cancelled | timed_out)
 * 状态转换优先级：cancelled > timed_out > failed > completed
 *
 * 特点：
 * - 每任务持有 AbortController，取消 = abort
 * - 超时：running 超时 → AbortController.abort() → timed_out
 * - 去重：复合幂等 key（prompt + caller_id + time_bucket_5min），支持 force 跳过
 * - 单向 reducer 保证状态转换线性
 *
 * 依赖：
 * - TaskStore：持久化抽象（MVP: per-task JSON）
 * - runtime 池接口：分配 runtime 执行任务（来自姊妹 ingress spec）
 */

import {
  type TaskRecord,
  type TaskStatus,
  type TaskSource,
  type CreateTaskInput,
  type TaskStore,
  type TaskFilter,
  canTransition,
  buildIdempotencyKey,
  generateTaskId,
  nowISO,
} from './task-store.js'

// ─── Runtime 池接口（来自姊妹 ingress spec，Phase 2 实施） ────

export interface RuntimeHandle {
  /** 在 runtime 上执行 AgentLoop，返回结果 */
  execute(prompt: string, signal: AbortSignal): Promise<RuntimeResult>
  /** 释放 runtime 回池 */
  release(): void
}

export interface RuntimeResult {
  summary: string
  changedFiles: string[]
  exitCode?: number
}

export interface RuntimePool {
  /** 获取一个可用的 runtime（可能新建或复用） */
  acquire(taskId: string): Promise<RuntimeHandle>
  /** 池中 runtime 数量 */
  size: number
}

// ─── TaskRegistry ──────────────────────────────────────────────

/** 任务事件回调 */
export type TaskEventCallback = (event: TaskEvent) => void

export interface TaskEvent {
  taskId: string
  type: 'created' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
  timestamp: string
}

export interface TaskRegistryConfig {
  taskStore: TaskStore
  runtimePool?: RuntimePool
  /** 默认任务超时（毫秒），默认 30 分钟 */
  defaultTimeoutMs?: number
  /** cron 任务默认超时，默认 60 分钟 */
  cronTimeoutMs?: number
  onEvent?: TaskEventCallback
}

export class TaskRegistry {
  private store: TaskStore
  private runtimePool?: RuntimePool
  private defaultTimeoutMs: number
  private cronTimeoutMs: number
  private onEvent?: TaskEventCallback

  /** 活跃任务的 AbortController 映射 */
  private abortControllers = new Map<string, AbortController>()

  /** 活跃任务的超时 timer */
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(config: TaskRegistryConfig) {
    this.store = config.taskStore
    this.runtimePool = config.runtimePool
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30 * 60 * 1000
    this.cronTimeoutMs = config.cronTimeoutMs ?? 60 * 60 * 1000
    this.onEvent = config.onEvent
    this.cronTimeoutMs = config.cronTimeoutMs ?? 60 * 60 * 1000
    this.onEvent = config.onEvent
  }

  // ─── 创建任务 ─────────────────────────────────────────────

  /** 创建任务并立即调度执行（如有 runtime 池） */
  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const callerId = input.callerId ?? 'anonymous'
    const idempotencyKey = input.idempotencyKey ?? buildIdempotencyKey(input.prompt, callerId)

    // 去重检查（force 跳过）
    if (!input.force) {
      const existing = await this.store.findActiveByIdempotencyKey(idempotencyKey)
      if (existing) return existing
    }

    const timeoutMs = input.timeoutMs ??
      (input.source === 'cron' ? this.cronTimeoutMs : this.defaultTimeoutMs)

    const record: TaskRecord = {
      id: generateTaskId(),
      prompt: input.prompt,
      source: input.source,
      status: 'pending',
      createdAt: nowISO(),
      timeoutMs,
      callerId,
      idempotencyKey,
      force: input.force ?? false,
    }

    await this.store.save(record)
    this.emit({ taskId: record.id, type: 'created', timestamp: record.createdAt })

    // 如有 runtime 池，立即调度
    if (this.runtimePool) {
      this.scheduleExecution(record).catch(err => {
        // 调度失败 → 标记 failed
        this.transition(record.id, 'failed', { error: String(err) }).catch(() => {})
      })
    }

    return record
  }

  // ─── 状态转换（单点 reducer） ──────────────────────────────

  /**
   * 原子状态转换。
   * 终态不可被低优先级覆盖（cancelled > timed_out > failed > completed）。
   */
  async transition(id: string, to: TaskStatus, extra?: { error?: string; result?: TaskRecord['result'] }): Promise<TaskRecord | null> {
    const record = await this.store.load(id)
    if (!record) return null

    // 终态保护：不可被低优先级覆盖
    if (!canTransition(record.status, to)) {
      return record
    }

    const now = nowISO()
    const updated: TaskRecord = {
      ...record,
      status: to,
      ...(to === 'running' ? { startedAt: record.startedAt ?? now } : {}),
      ...(to === 'completed' || to === 'failed' || to === 'cancelled' || to === 'timed_out' ? { completedAt: now } : {}),
      ...(extra?.error ? { error: extra.error } : {}),
      ...(extra?.result ? { result: extra.result } : {}),
    }

    await this.store.save(updated)
    this.emit({ taskId: id, type: to as TaskEvent['type'], timestamp: now })

    // 清理资源
    if (to === 'completed' || to === 'failed' || to === 'cancelled' || to === 'timed_out') {
      this.cleanup(id)
    }

    return updated
  }

  // ─── 取消 ──────────────────────────────────────────────────

  /** 取消任务。cancelled 是终态，不可被覆盖。 */
  async cancel(id: string): Promise<TaskRecord | null> {
    const ac = this.abortControllers.get(id)
    if (ac) {
      try { ac.abort() } catch { /* abort 可安全多次调用 */ }
    }
    return this.transition(id, 'cancelled')
  }

  // ─── 事件回调 ──────────────────────────────────────────────

  /** 设置事件回调（用于 task-routes 接线 events.jsonl） */
  setEventCallback(cb: TaskEventCallback): void {
    this.onEvent = cb
  }

  // ─── 查询 ──────────────────────────────────────────────────

  async getTask(id: string): Promise<TaskRecord | null> {
    return this.store.load(id)
  }

  async listTasks(filter?: TaskFilter): Promise<TaskRecord[]> {
    return this.store.list(filter)
  }

  /** 获取活跃（pending/running）任务 */
  async getActiveTasks(): Promise<TaskRecord[]> {
    return this.store.list({ status: ['pending', 'running'] })
  }

  /** 获取运行时超时的 running 任务，用于恢复 */
  async recoverStaleTasks(): Promise<TaskRecord[]> {
    // 进程重启后，所有 running 任务应标记为 timed_out
    const running = await this.store.list({ status: 'running' })
    const results: TaskRecord[] = []
    for (const r of running) {
      const t = await this.transition(r.id, 'timed_out')
      if (t) results.push(t)
    }
    return results
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  private emit(event: TaskEvent): void {
    try { this.onEvent?.(event) } catch { /* 回调不应抛异常 */ }
  }

  private cleanup(id: string): void {
    const timer = this.timeoutTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timeoutTimers.delete(id)
    }
    this.abortControllers.delete(id)
  }

  /**
   * 调度执行：分配 runtime → 启动 AgentLoop → 监控超时/取消 → 回写结果。
   * 仅在 runtimePool 已提供时可用。
   */
  private async scheduleExecution(record: TaskRecord): Promise<void> {
    if (!this.runtimePool) return

    await this.transition(record.id, 'running')

    const ac = new AbortController()
    this.abortControllers.set(record.id, ac)

    // 设置超时
    if (record.timeoutMs > 0) {
      const timer = setTimeout(() => {
        ac.abort()
        this.transition(record.id, 'timed_out', { error: `Task timed out after ${record.timeoutMs}ms` }).catch(() => {})
      }, record.timeoutMs)
      this.timeoutTimers.set(record.id, timer)
    }

    // 取消信号 → abort controller
    // （外部 cancel() 已调 ac.abort()，这里监听 signal 做清理）

    let handle: RuntimeHandle | null = null
    try {
      handle = await this.runtimePool.acquire(record.id)

      // 检查是否已被取消
      if (ac.signal.aborted) {
        handle.release()
        return // cancel() 已处理状态转换
      }

      const result = await handle.execute(record.prompt, ac.signal)

      await this.transition(record.id, 'completed', { result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (ac.signal.aborted) {
        // 如果是被 abort 的，检查是否已经是 timed_out（超时触发）
        // 如果还不是 → cancelled（手动取消）
        const current = await this.getTask(record.id)
        if (current && current.status !== 'timed_out' && current.status !== 'cancelled') {
          await this.transition(record.id, 'cancelled', { error: message })
        }
      } else {
        await this.transition(record.id, 'failed', { error: message })
      }
    } finally {
      handle?.release()
    }
  }
}
