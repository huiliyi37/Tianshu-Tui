import type { CapabilityTask } from './capability.js'

export interface RoutingEvent {
  turn: number
  inferredTask: CapabilityTask
  recommendedModel: string
  currentModel: string
  switched: boolean
  reason: string
  timestamp: number
  verificationOutcome?: 'passed' | 'failed' | 'blocked'
}

const MAX_ROUTING_EVENTS = 100

export class RoutingMetricsCollector {
  private events: RoutingEvent[] = []

  record(event: RoutingEvent): void {
    this.events.push(event)
    if (this.events.length > MAX_ROUTING_EVENTS) {
      this.events = this.events.slice(-MAX_ROUTING_EVENTS)
    }
  }

  getEvents(): RoutingEvent[] {
    return [...this.events]
  }

  getStats(): { total: number; switches: number; byTask: Record<string, number> } {
    const byTask: Record<string, number> = {}
    let switches = 0
    for (const e of this.events) {
      byTask[e.inferredTask] = (byTask[e.inferredTask] ?? 0) + 1
      if (e.switched) switches++
    }
    return { total: this.events.length, switches, byTask }
  }

  clear(): void {
    this.events = []
  }
}
