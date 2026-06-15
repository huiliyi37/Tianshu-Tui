import { createTrace, appendResult, serializeTrace, detectDeviation, buildPlanSteps, withPlanSteps } from './plan-execution-trace.js'
import type { PlanExecutionTrace, StepResult } from './plan-execution-trace.js'
import { correctPlan, injectReplanContext } from './replan-loop.js'
import { wrapSystemReminder } from '../prompt/system-reminder.js'
import type { TaskDepthLayer } from '../context/task-contract.js'

export interface PlanTraceCoordinatorDeps {
  getPlanTrace: () => PlanExecutionTrace | null
  setPlanTrace: (t: PlanExecutionTrace | null) => void
  getLastReplanInjection: () => string
  setLastReplanInjection: (s: string) => void
  getLatestConvergenceResult: () => import('./convergence-detector.js').ConvergenceResult | null
  getConsecutiveNoToolTurns: () => number
  getTraceStore: () => import('./trace-store.js').TraceStore | null
  addSystemReminder: (content: string) => void
  setPlanTraceAppendix: (appendix: string | null) => void
}

export class PlanTraceCoordinator {
  constructor(private deps: PlanTraceCoordinatorDeps) {}

  /** U6/C1: seed the execution trace from the agent's first todo write. */
  capturePlanSteps(descriptions: string[]): void {
    const pt = this.deps.getPlanTrace()
    if (!pt) return
    this.deps.setPlanTrace(withPlanSteps(pt, buildPlanSteps(descriptions, pt.depthLayer)))
  }

  /** U6: build a StepResult from the tool events recorded for a given turn. */
  buildStepResultFromTurn(turn: number): StepResult | null {
    const pt = this.deps.getPlanTrace()
    if (!pt) return null
    const store = this.deps.getTraceStore()
    if (!store) return null
    const toolEvents = store.events.filter(e => e.kind === 'tool' && e.turn === turn)
    if (toolEvents.length === 0) return null
    const toolCalls = toolEvents.map(e => ({ tool: e.name, result_summary: (e.summary ?? '').slice(0, 80) }))
    const failed = toolEvents.some(e => e.status === 'failed' || e.status === 'blocked')
    const activeStep = pt.steps.find(s => s.status === 'active' || s.status === 'pending')
    const stepId = activeStep?.id ?? `turn-${turn}`
    return { stepId, turnNumber: turn, toolCalls, status: failed ? 'blocked' : 'done' }
  }

  /** U6: turn-boundary deviation check. No-op until trace has steps. */
  runReplanCheck(): void {
    const pt = this.deps.getPlanTrace()
    if (!pt || pt.steps.length === 0) return
    const lastResult = pt.history[pt.history.length - 1]
    const deviation = detectDeviation(
      pt,
      lastResult,
      this.deps.getLatestConvergenceResult()?.level,
      this.deps.getConsecutiveNoToolTurns(),
    )
    if (deviation.type !== 'none') {
      const { trace, addedSteps } = correctPlan(pt, deviation)
      this.deps.setPlanTrace(trace)
      const ctx = injectReplanContext(deviation, addedSteps)
      if (ctx.text && ctx.text !== this.deps.getLastReplanInjection()) {
        this.deps.setLastReplanInjection(ctx.text)
        this.deps.addSystemReminder(ctx.text)
      }
    }
    this.deps.setPlanTraceAppendix(serializeTrace(pt) || null)
  }

  /** U6: open a fresh execution trace for a new task (or a changed contract). */
  openTrace(contractId: string, depthLayer: TaskDepthLayer): void {
    const pt = this.deps.getPlanTrace()
    if (!pt || pt.contractId !== contractId) {
      this.deps.setPlanTrace(createTrace(contractId, depthLayer))
      this.deps.setLastReplanInjection('')
      this.deps.setPlanTraceAppendix(null)
    }
  }

  /** U6: drop any prior trace + clear its prompt surfaces. */
  closeTrace(): void {
    if (this.deps.getPlanTrace()) {
      this.deps.setPlanTrace(null)
      this.deps.setLastReplanInjection('')
      this.deps.setPlanTraceAppendix(null)
    }
  }

  /** U6: record this tool-turn into the execution trace. */
  appendTurnResult(turn: number): void {
    const pt = this.deps.getPlanTrace()
    if (!pt || pt.steps.length === 0) return
    const stepResult = this.buildStepResultFromTurn(turn)
    if (stepResult) this.deps.setPlanTrace(appendResult(pt, stepResult))
  }
}
