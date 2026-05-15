export type WorkerEventType = 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'escalated'

export interface WorkerEvent {
  type: WorkerEventType
  workOrderId: string
  timestamp: number
  detail?: string
}

export interface CoordinatorSummary {
  /** Cumulative event counts — each completed work order increments queued, running, AND its terminal status */
  queued: number
  running: number
  passed: number
  failed: number
  blocked: number
  escalated: number
}

export interface FailureBudgetConfig {
  maxFailures: number
}

const MAX_EVENTS = 100

export class CoordinatorState {
  private events: WorkerEvent[] = []
  private maxConcurrency: number
  private failureBudget: FailureBudgetConfig
  private consecutiveFailures = 0

  constructor(maxConcurrency = 2, failureBudget?: FailureBudgetConfig) {
    this.maxConcurrency = maxConcurrency
    this.failureBudget = failureBudget ?? { maxFailures: 3 }
  }

  recordEvent(event: WorkerEvent): void {
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS)
    }
    if (event.type === 'failed') this.consecutiveFailures++
    if (event.type === 'passed') this.consecutiveFailures = 0
  }

  shouldEscalate(): boolean {
    return this.consecutiveFailures >= this.failureBudget.maxFailures
  }

  getEvents(): WorkerEvent[] {
    return [...this.events]
  }

  getSummary(): CoordinatorSummary {
    const summary: CoordinatorSummary = { queued: 0, running: 0, passed: 0, failed: 0, blocked: 0, escalated: 0 }
    for (const event of this.events) {
      summary[event.type]++
    }
    return summary
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency
  }
}
