/**
 * Cron Wiring — cron-scheduler → TaskRegistry → runtime → AgentLoop 接线
 *
 * Spec A 改造二 P2：把 cron-scheduler、TaskRegistry、runtime 池串成完整链路。
 *
 * 链路：
 *   CronScheduler（时间触发 tick）
 *     → onCreateTask 回调
 *       → TaskRegistry.createTask(source: 'cron')
 *         → scheduleExecution()（如有 runtimePool）
 *           → RuntimePool.acquire() → AgentLoop（自带 maxTurns + AbortSignal + TurnHeartbeat）
 *             → 结果回写 TaskRegistry（completed/failed/cancelled/timed_out）
 *
 * 部署模式：
 * - 单 daemon 进程：直接 start()，锁 YAGNI
 * - 多进程：先 CronLock.acquire()，仅 owner 启动 scheduler
 */

import { CronScheduler } from './cron-scheduler.js'
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

  constructor(config: CronWiringConfig) {
    this.scheduler = config.scheduler
    this.registry = config.registry
    this.lock = config.lock

    // 接线：scheduler 触发 → TaskRegistry 创建 cron 任务
    // 直接将 Scheduler 串行覆写 onCreateTask 是不安全的（失去 observer 语义），
    // 但当前 CronScheduler 的单回调设计下这是唯一接法。若未来有多订阅者需求，改为 emitter 模式。
    this.scheduler['onCreateTask'] = async (prompt: string, allowedTools: string[], agentId?: string) => {
      await this.registry.createTask({
        prompt,
        source: 'cron',
        callerId: agentId ?? 'cron-scheduler',
        // 保留空数组语义（空=无工具，undefined=默认全量）
        allowedTools: allowedTools,
      })
    }

    // 如有 runtime 池，注入到 TaskRegistry（使 scheduleExecution 可用）
    if (config.runtimePool) {
      this.registry['runtimePool'] = config.runtimePool
    }
  }

  /** 启动调度器。多进程部署时先抢锁。 */
  async start(): Promise<CronWiringStatus> {
    // 如有锁，尝试获取
    if (this.lock) {
      const lockState = this.lock.acquire()
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

    // 启动调度器
    this.scheduler.start()

    return this.getStatus()
  }

  /** 停止调度器并释放锁 */
  async stop(): Promise<void> {
    this.scheduler.stop()
    this.lock?.release()
  }

  /** 注入 runtime 池（延后接线，供 ingress spec Phase 2 就绪后使用） */
  setRuntimePool(pool: RuntimePool): void {
    this.registry['runtimePool'] = pool
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
