import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { processTurnEnd, type TurnEndDeps } from '../turn-end.js'
import { setTodos } from '../../tools/todo.js'
import { TodoStore } from '../../tools/todo-store.js'

describe('processTurnEnd', () => {
  function makeDeps(overrides?: Partial<TurnEndDeps>): TurnEndDeps {
    return {
      config: {
        promptEngine: {
          setTaskProgress: () => {},
          setDecisions: () => {},
        },
        modelCards: undefined,
        getCurrentModel: undefined,
        onModelSwitch: undefined,
      } as any,
      session: { getTurnCount: () => 5 } as any,
      trajectory: { getEntries: () => [] } as any,
      streamedText: 'I will fix the bug in auth.ts',
      routingMetrics: { record: () => {} } as any,
      decisions: [],
      evidence: {} as any,
      ...overrides,
    }
  }

  it('returns empty decisions when no decisions in text', () => {
    const result = processTurnEnd(makeDeps())
    assert.ok(Array.isArray(result.decisions))
  })

  it('skips task state for early turns (≤3)', () => {
    let called = false
    processTurnEnd(makeDeps({
      session: { getTurnCount: () => 2 } as any,
      config: {
        promptEngine: {
          setTaskProgress: () => { called = true },
          setDecisions: () => {},
        },
      } as any,
    }))
    assert.equal(called, false)
  })

  it('extracts task state for later turns (>3)', () => {
    let called = false
    processTurnEnd(makeDeps({
      session: { getTurnCount: () => 5 } as any,
      config: {
        promptEngine: {
          setTaskProgress: () => { called = true },
          setDecisions: () => {},
        },
      } as any,
    }))
    assert.equal(called, true)
  })

  it('caps decisions at 3', () => {
    const result = processTurnEnd(makeDeps({
      decisions: ['d1', 'd2', 'd3', 'd4'],
    }))
    assert.ok(result.decisions.length <= 3)
  })

  it('backfills task progress from turn 0 when a todo list exists', () => {
    setTodos([{ id: '1', content: 'wire it up', status: 'in_progress' }])
    try {
      let called = false
      processTurnEnd(makeDeps({
        session: { getTurnCount: () => 1 } as any,
        config: {
          promptEngine: {
            setTaskProgress: () => { called = true },
            setDecisions: () => {},
          },
        } as any,
      }))
      // Existing list is the model's own decomposition → injected even at turn ≤3,
      // unlike the heuristic which stays gated behind turn > 3.
      assert.equal(called, true)
    } finally {
      setTodos([]) // restore singleton so the "skips early turns" test stays valid
    }
  })

  it('W4-D2: routing event carries the latest verification outcome', () => {
    const recorded: any[] = []
    processTurnEnd(makeDeps({
      routingMetrics: { record: (e: any) => recorded.push(e) } as any,
      trajectory: {
        getEntries: () => Array.from({ length: 6 }, () => ({ tool: 'run_tests', status: 'failed', target: 'src/a.test.ts', errorClass: 'assertion' })),
      } as any,
      evidence: {
        getState: () => ({
          verifications: [
            { command: 'npm test', status: 'passed', scope: 'full', exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 100 },
            { command: 'npm test', status: 'failed', scope: 'full', exitCode: 1, passed: 3, failed: 2, skipped: 0, durationMs: 100 },
          ],
          filesModified: new Set<string>(),
        }),
      } as any,
      config: {
        promptEngine: { setTaskProgress: () => {}, setDecisions: () => {} },
        // 6 failed run_tests → test_failure_diagnosis; strong-repair card wins
        // over the current weak card → a switch event is deterministically recorded.
        modelCards: [
          { model: 'model-strong', toolUseReliability: 0.9, jsonStability: 0.9, editSuccessRate: 0.9, testRepairRate: 0.95, contextWindow: 128_000, cacheEconomics: 'strong', recommendedTasks: ['test_failure_diagnosis'] },
          { model: 'model-weak', toolUseReliability: 0.5, jsonStability: 0.5, editSuccessRate: 0.5, testRepairRate: 0.1, contextWindow: 128_000, cacheEconomics: 'weak', recommendedTasks: [] },
        ],
        getCurrentModel: () => 'model-weak',
        onModelSwitch: () => {},
      } as any,
    }))
    assert.equal(recorded.length, 1, 'switch recommendation must be recorded')
    // Latest verification (failed) — not the first — must ride the event.
    assert.equal(recorded[0].verificationOutcome, 'failed')
    assert.equal(recorded[0].recommendedModel, 'model-strong')
  })

  it('reads the injected per-session store via config.getTodos (not the global singleton)', () => {
    // 全局清空，证明回灌读的是注入 store 而非全局 defaultStore。
    setTodos([])
    const sessionStore = new TodoStore()
    sessionStore.write([{ id: 's1', content: 'session-scoped task', status: 'in_progress' }])
    let injected: any
    processTurnEnd(makeDeps({
      session: { getTurnCount: () => 1 } as any,
      config: {
        getTodos: () => sessionStore.read(),
        promptEngine: {
          setTaskProgress: (p: any) => { injected = p },
          setDecisions: () => {},
        },
      } as any,
    }))
    // turn≤3 且全局为空：若读全局会跳过(injected undefined)；读注入 store 则回灌。
    assert.ok(injected, 'should backfill from injected store even when global is empty')
  })
})
