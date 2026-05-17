import { computeFluencyPolicy, RoutineCounter, type FluencyPolicy, type FluencySignals } from './fluency-policy.js'

const ROUTINE_TOOLS = new Set(['read_file', 'grep', 'glob', 'inspect_project', 'repo_map', 'related_tests', 'recall', 'diff'])

export interface ToolResultEvent {
  name: string
  isError: boolean
  resultLength: number
}

export class FluencyTracker {
  private routine = new RoutineCounter()
  private lastEventAt = Date.now()
  private contextPressure = 0
  private lastIsError = false
  private lastIsApproval = false
  private phase: FluencySignals['phase'] = 'idle'

  isRoutineTool(name: string, isError: boolean): boolean {
    if (isError) return false
    return ROUTINE_TOOLS.has(name)
  }

  recordToolResult(event: ToolResultEvent): void {
    this.routine.record(this.isRoutineTool(event.name, event.isError))
    this.lastEventAt = Date.now()
    this.lastIsError = event.isError
    this.lastIsApproval = false
    this.phase = 'tool'
  }

  recordApproval(): void {
    this.lastIsApproval = true
    this.routine.reset()
  }

  setContextPressure(pressure: number): void {
    this.contextPressure = pressure
  }

  setPhase(phase: FluencySignals['phase']): void {
    this.phase = phase
    this.lastEventAt = Date.now()
  }

  updateSilence(silentMs: number): void {
    this.lastEventAt = Date.now() - silentMs
  }

  onTurnComplete(): void {
    this.routine.reset()
    this.lastIsError = false
    this.lastIsApproval = false
    this.phase = 'idle'
  }

  getPolicy(): FluencyPolicy {
    const signals: FluencySignals = {
      phase: this.phase,
      silentMs: Date.now() - this.lastEventAt,
      outputRate: 0,
      resultLength: 0,
      contextPressure: this.contextPressure,
      isError: this.lastIsError,
      isApproval: this.lastIsApproval,
      consecutiveRoutine: this.routine.count,
    }
    return computeFluencyPolicy(signals)
  }
}
