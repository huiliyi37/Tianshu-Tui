import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TurnCompletionController } from '../turn-completion.js'
import { SessionContext } from '../context.js'
import { TrajectoryRecorder } from '../trajectory.js'
import { RoutingMetricsCollector } from '../../model/routing-metrics.js'
import { EvidenceTracker } from '../evidence.js'
import type { AgentConfig } from '../loop.js'

function makeConfig(): AgentConfig {
  return {
    client: { stream: async () => {} },
    promptEngine: {
      setTaskProgress: () => {},
      setBehaviorMirror: () => {},
      setRoutingReason: () => {},
      setDecisions: () => {},
    } as unknown as AgentConfig['promptEngine'],
    toolRegistry: {} as AgentConfig['toolRegistry'],
    maxTurns: 1,
    contextWindow: 128_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }
}

describe('TurnCompletionController', () => {
  it('runs turn-end side effects and emits final completion', async () => {
    const session = new SessionContext()
    session.addUserMessage('finish task')
    const decisions: string[][] = []
    let ledgerRefreshed = 0
    let diagnosticTurn = -1
    let postTurn = 0
    let beforeComplete = 0
    const completions: Array<{ turn: number; isFinal?: boolean }> = []
    const texts: string[] = []

    const controller = new TurnCompletionController({
      config: makeConfig(),
      session,
      trajectory: new TrajectoryRecorder(),
      routingMetrics: new RoutingMetricsCollector(),
      evidence: new EvidenceTracker(),
      getStreamedText: () => 'plan: keep implementation simple and verify incrementally.',
      getDecisions: () => [],
      setDecisions: next => { decisions.push(next) },
      refreshLedger: () => { ledgerRefreshed++ },
      refreshCacheDiagnostic: turn => { diagnosticTurn = turn },
      runPostTurn: async () => { postTurn++ },
      runBeforeComplete: async () => { beforeComplete++ },
    })

    await controller.complete({
      turn: 7,
      isFinal: true,
      emitBadge: true,
      callbacks: {
        onTextDelta: text => { texts.push(text) },
        onTurnComplete: (_usage, turn, isFinal) => { completions.push({ turn, isFinal }) },
      },
    })

    assert.deepEqual(decisions.at(-1), ['keep implementation simple and verify incrementally'])
    assert.equal(ledgerRefreshed, 1)
    assert.equal(diagnosticTurn, 7)
    assert.equal(postTurn, 1)
    assert.equal(beforeComplete, 1)
    assert.deepEqual(completions, [{ turn: 1, isFinal: true }])
    assert.deepEqual(texts, [])
  })
})
