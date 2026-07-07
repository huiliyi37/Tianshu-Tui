import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PlanTraceCoordinator, type PlanTraceCoordinatorDeps } from '../plan-trace-coordinator.js'
import type { PlanExecutionTrace } from '../plan-execution-trace.js'
import type { TraceStore, TraceEvent } from '../trace-store.js'
import type { ConvergenceResult } from '../convergence-detector.js'

/**
 * C-line: PlanTraceCoordinator was extracted during the loop "上帝对象分解"
 * but shipped with zero dedicated tests. Its dependency-injected shape makes
 * the lifecycle (open/close idempotency, step-result mapping, replan-injection
 * dedup, appendix surfacing) directly unit-testable with fake deps.
 */

interface FakeState {
  planTrace: PlanExecutionTrace | null
  lastReplanInjection: string
  convergence: ConvergenceResult | null
  consecutiveNoTool: number
  traceStore: TraceStore | null
  reminders: string[]
  appendix: string | null | undefined
}

function makeCoord(init?: Partial<FakeState>) {
  const state: FakeState = {
    planTrace: null,
    lastReplanInjection: '',
    convergence: null,
    consecutiveNoTool: 0,
    traceStore: null,
    reminders: [],
    appendix: undefined,
    ...init,
  }
  const deps: PlanTraceCoordinatorDeps = {
    getPlanTrace: () => state.planTrace,
    setPlanTrace: (t) => { state.planTrace = t },
    getLastReplanInjection: () => state.lastReplanInjection,
    setLastReplanInjection: (s) => { state.lastReplanInjection = s },
    getLatestConvergenceResult: () => state.convergence,
    getConsecutiveNoToolTurns: () => state.consecutiveNoTool,
    getTraceStore: () => state.traceStore,
    addSystemReminder: (c) => { state.reminders.push(c) },
    setPlanTraceAppendix: (a) => { state.appendix = a },
  }
  return { coord: new PlanTraceCoordinator(deps), state }
}

function evt(turn: number, name: string, status: TraceEvent['status']): TraceEvent {
  return { id: `${name}-${turn}`, turn, kind: 'tool', name, status, startedAt: 0 }
}

function storeWith(events: TraceEvent[]): TraceStore {
  return { maxEvents: 50, events, toolFingerprints: [] }
}

describe('PlanTraceCoordinator (C-line: extracted, was untested)', () => {
  it('openTrace creates a trace for a new contract and is idempotent for the same id', () => {
    const { coord, state } = makeCoord()
    coord.openTrace('contract-A', 'system')
    const first = state.planTrace
    assert.ok(first, 'trace created')
    assert.equal(first!.contractId, 'contract-A')

    // Same contract → must NOT recreate (would wipe an in-flight trace).
    coord.openTrace('contract-A', 'system')
    assert.strictEqual(state.planTrace, first, 'same-contract reopen is a no-op (identity preserved)')
  })

  it('openTrace resets trace + clears injection/appendix when the contract changes', () => {
    const { coord, state } = makeCoord()
    coord.openTrace('contract-A', 'system')
    state.lastReplanInjection = 'stale injection'
    state.appendix = 'stale appendix'

    coord.openTrace('contract-B', 'wiring')
    assert.equal(state.planTrace!.contractId, 'contract-B')
    assert.equal(state.lastReplanInjection, '', 'replan injection cleared on contract switch')
    assert.equal(state.appendix, null, 'appendix cleared on contract switch')
  })

  it('capturePlanSteps seeds steps from descriptions (only on an empty trace)', () => {
    const { coord, state } = makeCoord()
    coord.openTrace('c', 'system')
    coord.capturePlanSteps(['read the file', 'edit the file', ''])
    assert.equal(state.planTrace!.steps.length, 2, 'blank descriptions filtered out')
    assert.equal(state.planTrace!.steps[0]!.id, 'step-1')
    assert.equal(state.planTrace!.steps[0]!.status, 'pending')
  })

  it('capturePlanSteps is a no-op when no trace is open', () => {
    const { coord, state } = makeCoord()
    coord.capturePlanSteps(['x'])
    assert.equal(state.planTrace, null)
  })

  it('buildStepResultFromTurn maps a turn’s tool events and marks blocked on any failure', () => {
    const { coord, state } = makeCoord()
    coord.openTrace('c', 'system')
    coord.capturePlanSteps(['step one'])
    state.traceStore = storeWith([
      evt(1, 'read_file', 'passed'),
      evt(1, 'bash', 'failed'),
      evt(2, 'edit', 'passed'),
    ])

    const r1 = coord.buildStepResultFromTurn(1)
    assert.ok(r1)
    assert.equal(r1!.stepId, 'step-1', 'maps onto the active/pending step')
    assert.equal(r1!.toolCalls.length, 2, 'only this turn’s tool events')
    assert.equal(r1!.status, 'blocked', 'any failed/blocked event blocks the step')

    const r2 = coord.buildStepResultFromTurn(2)
    assert.equal(r2!.status, 'done', 'all-passed turn → done')

    assert.equal(coord.buildStepResultFromTurn(99), null, 'no events for the turn → null')
  })

  it('buildStepResultFromTurn returns null without a trace or store', () => {
    const { coord, state } = makeCoord()
    assert.equal(coord.buildStepResultFromTurn(1), null, 'no trace → null')
    coord.openTrace('c', 'system')
    coord.capturePlanSteps(['s'])
    assert.equal(coord.buildStepResultFromTurn(1), null, 'trace but no store → null')
    state.traceStore = storeWith([])
    assert.equal(coord.buildStepResultFromTurn(1), null, 'empty store → null')
  })

  it('appendTurnResult records the turn into history and advances step status', () => {
    const { coord, state } = makeCoord()
    coord.openTrace('c', 'system')
    coord.capturePlanSteps(['only step'])
    state.traceStore = storeWith([evt(1, 'edit', 'passed')])

    coord.appendTurnResult(1)
    assert.equal(state.planTrace!.history.length, 1, 'result appended to history')
    assert.equal(state.planTrace!.history[0]!.turnNumber, 1)
  })

  it('appendTurnResult is a no-op when the trace has no steps', () => {
    const { coord, state } = makeCoord()
    coord.openTrace('c', 'system') // trace open but no steps captured
    state.traceStore = storeWith([evt(1, 'edit', 'passed')])
    coord.appendTurnResult(1)
    assert.equal(state.planTrace!.history.length, 0)
  })

  it('runReplanCheck surfaces the serialized trace into the appendix once steps exist', () => {
    const { coord, state } = makeCoord()
    coord.openTrace('c', 'system')
    coord.capturePlanSteps(['s1', 's2'])
    coord.runReplanCheck()
    assert.ok(state.appendix && state.appendix.includes('<plan-execution-trace'), 'appendix gets serialized trace')
  })

  it('runReplanCheck is a no-op before any steps are captured', () => {
    const { coord, state } = makeCoord()
    coord.openTrace('c', 'system') // openTrace already cleared appendix → null
    coord.runReplanCheck()
    assert.equal(state.appendix, null, 'no serialized-trace write without steps')
    assert.equal(state.reminders.length, 0, 'no replan reminder injected without steps')
  })

  it('closeTrace clears the trace and both prompt surfaces', () => {
    const { coord, state } = makeCoord()
    coord.openTrace('c', 'system')
    coord.capturePlanSteps(['s'])
    state.lastReplanInjection = 'x'
    state.appendix = 'y'
    coord.closeTrace()
    assert.equal(state.planTrace, null)
    assert.equal(state.lastReplanInjection, '')
    assert.equal(state.appendix, null)
  })
})
