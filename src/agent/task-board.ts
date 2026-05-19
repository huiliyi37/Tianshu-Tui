import type { DomainArea, WorkOrder, WorkerResult } from './work-order.js'
import type { WorkOrderQueue, QueueEvent } from './work-queue.js'

export type BoardTaskStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface BoardTask {
  id: string
  seq: number
  title: string
  objective: string
  domain: DomainArea
  status: BoardTaskStatus
  dependsOn: string[]
  scope: { files: string[] }
  result?: WorkerResult
  startedAt?: number
  completedAt?: number
}

export type BoardEvent =
  | { type: 'task:added'; task: BoardTask }
  | { type: 'task:started'; taskId: string }
  | { type: 'task:completed'; taskId: string }
  | { type: 'task:failed'; taskId: string }

/**
 * TaskBoard — 纯读投影层。
 * 监听 WorkOrderQueue 事件，构建面向 TUI 的任务视图。
 * 不做调度，不做决策，只提供查询接口。
 */
export class TaskBoard {
  private tasks = new Map<string, BoardTask>()
  private seq = 0
  private listeners: Array<(event: BoardEvent) => void> = []

  constructor(queue: WorkOrderQueue) {
    queue.on(event => this.handleQueueEvent(event))
  }

  private handleQueueEvent(event: QueueEvent): void {
    switch (event.type) {
      case 'enqueued': {
        const task: BoardTask = {
          id: event.order.id,
          seq: ++this.seq,
          title: event.order.objective.slice(0, 60),
          objective: event.order.objective,
          domain: event.order.domain ?? 'backend',
          status: 'pending',
          dependsOn: event.order.dependencies,
          scope: { files: event.order.scope.files ?? [] },
        }
        this.tasks.set(task.id, task)
        this.emit({ type: 'task:added', task })
        break
      }
      case 'dequeued': {
        const task = this.tasks.get(event.order.id)
        if (task) {
          const updated = { ...task, status: 'running' as const, startedAt: Date.now() }
          this.tasks.set(task.id, updated)
          this.emit({ type: 'task:started', taskId: task.id })
        }
        break
      }
      case 'completed': {
        const task = this.tasks.get(event.orderId)
        if (task) {
          const updated = { ...task, status: 'completed' as const, completedAt: Date.now() }
          this.tasks.set(task.id, updated)
          this.emit({ type: 'task:completed', taskId: task.id })
        }
        break
      }
      case 'failed': {
        const task = this.tasks.get(event.orderId)
        if (task) {
          const updated = { ...task, status: 'failed' as const, completedAt: Date.now() }
          this.tasks.set(task.id, updated)
          this.emit({ type: 'task:failed', taskId: task.id })
        }
        break
      }
    }
  }

  // ── 查询接口（TUI 消费）──
  getTask(id: string): BoardTask | undefined { return this.tasks.get(id) }
  getTasksByDomain(domain: DomainArea): BoardTask[] { return [...this.tasks.values()].filter(t => t.domain === domain) }
  getAllTasks(): BoardTask[] { return [...this.tasks.values()].sort((a, b) => a.seq - b.seq) }
  getActiveTasks(): BoardTask[] { return [...this.tasks.values()].filter(t => t.status === 'running') }
  getProgress(): { total: number; completed: number; failed: number; running: number } {
    const tasks = [...this.tasks.values()]
    return {
      total: tasks.length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      running: tasks.filter(t => t.status === 'running').length,
    }
  }

  // ── 事件转发（TUI 订阅）──
  on(listener: (event: BoardEvent) => void): () => void {
    this.listeners.push(listener)
    return () => { this.listeners = this.listeners.filter(l => l !== listener) }
  }
  private emit(event: BoardEvent): void {
    for (const l of this.listeners) l(event)
  }
}
