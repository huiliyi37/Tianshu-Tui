/**
 * Cron Wiring — cron-scheduler → TaskRegistry → runtime → AgentLoop 接线
 *
 * Spec A 改造二 P2：把 cron-scheduler、TaskRegistry、runtime 池串成完整链路。
 *
 * 链路：
 *   CronScheduler（时间触发 tick）
 *     → task-due subscription
 *       → TaskRegistry.createTask(source: 'cron')
 *         → scheduleExecution()（如有 runtimePool）
 *           → RuntimePool.acquire() → AgentLoop（自带 maxTurns + AbortSignal + TurnHeartbeat）
 *             → 结果回写 TaskRegistry（completed/failed/cancelled/timed_out）
 *
 * 部署模式：
 * - 单 daemon 进程：直接 start()，锁 YAGNI
 * - 多进程：先 CronLock.acquire()，仅 owner 启动 scheduler
 */

import { CronScheduler, type UnsubscribeTaskDue } from './cron-scheduler.js'
import { CronLock } from './cron-lock.js'
import { TaskRegistry, type RuntimePool } from './task-registry.js'

// ─── Types ────────────────────────────────────────────────────

export interface CronWiringConfig {
  scheduler: CronScheduler
  registry: TaskRegistry
  lock?: CronLock
  /** 提供 runtime 池后，cron 任务会自动调度到 runtime 执行 */
  runtimePool?: RuntimePool
}

export interface CronWiringStatus {
  schedulerRunning: boolean
  lockOwner: boolean
  activeTasks: number
  scheduledCount: number
}

// ─── CronWiring ───────────────────────────────────────────────

export class CronWiring {
  private scheduler: CronScheduler
  private registry: TaskRegistry
  private lock?: CronLock
  private unsubscribeTaskDue: UnsubscribeTaskDue
  private unsubscribeLockLost?: () => void

  constructor(config: CronWiringConfig) {
    this.scheduler = config.scheduler
    this.registry = config.registry
    this.lock = config.lock
    this.unsubscribeLockLost = this.lock?.onLockLost(() => {
      this.scheduler.stop()
    })

    // 接线：scheduler 触发 → TaskRegistry 创建 cron 任务。
    // 使用显式订阅 API，避免方括号私有写入和单回调覆盖。
    this.unsubscribeTaskDue = this.scheduler.subscribeTaskDue(async (prompt, allowedTools, agentId) => {
      await this.registry.createTask({
        prompt,
        source: 'cron',
        callerId: agentId ?? 'cron-scheduler',
        // 保留空数组语义（空=无工具，undefined=默认全量）
        allowedTools,
      })
    })

    if (config.runtimePool) {
      this.registry.setRuntimePool(config.runtimePool)
    }
  }

  /** 启动调度器。多进程部署时先抢锁。 */
  async start(): Promise<CronWiringStatus> {
    if (this.lock) {
      this.lock.acquire()
      if (!this.lock.isOwner()) {
        return {
          schedulerRunning: false,
          lockOwner: false,
          activeTasks: 0,
          scheduledCount: this.scheduler.list().length,
        }
      }
    }

    // 恢复陈旧任务（进程重启后 running → timed_out）
    await this.registry.recoverStaleTasks()

    this.scheduler.start()

    return this.getStatus()
  }

  /** 停止调度器并释放锁 */
  async stop(): Promise<void> {
    this.scheduler.stop()
    this.lock?.release()
  }

  /** 彻底断开接线。 */
  dispose(): void {
    this.unsubscribeTaskDue()
    this.unsubscribeLockLost?.()
    this.unsubscribeLockLost = undefined
  }

  /** 注入 runtime 池（延后接线，供 ingress spec Phase 2 就绪后使用） */
  setRuntimePool(pool: RuntimePool): void {
    this.registry.setRuntimePool(pool)
  }

  /** 获取当前状态 */
  async getStatus(): Promise<CronWiringStatus> {
    const activeTasks = await this.registry.getActiveTasks()
    return {
      schedulerRunning: this.scheduler.isRunning(),
      lockOwner: this.lock?.isOwner() ?? true,
      activeTasks: activeTasks.length,
      scheduledCount: this.scheduler.list().length,
    }
  }
}
