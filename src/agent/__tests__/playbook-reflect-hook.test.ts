import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createPlaybookReflectHook } from '../hooks/playbook-reflect-hook.js'
import { PlaybookStore } from '../playbook-store.js'
import { createVigorState } from '../vigor.js'
import type { Sensorium } from '../sensorium.js'
import type { RetrospectInput } from '../retrospect.js'

function sensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.4,
    pressure: 0.2,
    confidence: 0.4,
    complexity: 0.7,
    freshness: 0.5,
    stability: 0.3,
    ...overrides,
  }
}

function retrospectInput(): RetrospectInput {
  return {
    sensoriumEntries: [
      { ts: 1, turn: 1, phase: 'x', momentum: 0.6, pressure: 0.2, confidence: 0.9, complexity: 0.2, freshness: 0.5, stability: 0.9, strategy: { reasoningEffort: 'medium', shouldEscalate: false, thetaInterval: 7 } },
      { ts: 2, turn: 2, phase: 'y', momentum: 0.4, pressure: 0.2, confidence: 0.3, complexity: 0.7, freshness: 0.5, stability: 0.2, strategy: { reasoningEffort: 'high', shouldEscalate: true, thetaInterval: 3 } },
    ],
    gitLog: [],
    toolEvents: [{ turn: 2, name: 'run_tests', status: 'failed' }],
    evidenceSummary: { filesModified: 1, verifiedCount: 0 },
  }
}

function ctx(phases: Array<{ phase: string; suggestion?: string }> = []) {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 2,
    recentToolHistory: [],
    sensorium: sensorium(),
    strategy: null,
    vigor: createVigorState({ variability: 0.35 }),
    gitChangeRate: 0,
    season: null,
  }, {
    emitPhaseChange: (phase, detail) => { phases.push({ phase, suggestion: detail?.suggestion }) },
  })
}

function withStore(fn: (store: PlaybookStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-playbook-hook-'))
  try {
    fn(new PlaybookStore(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('createPlaybookReflectHook', () => {
  it('stores extracted bullets when reflection criteria are met', () => {
    withStore((store) => {
      const phases: Array<{ phase: string; suggestion?: string }> = []
      const hook = createPlaybookReflectHook({
        store,
        buildRetrospectInput: retrospectInput,
        getDoomLoopLevel: () => 'blocked',
      })

      hook.run(ctx(phases))

      const bullets = store.load()
      assert.ok(bullets.length > 0)
      assert.equal(phases[0]!.phase, 'playbook-reflect')
    })
  })

  it('does not reflect on smooth sessions', () => {
    withStore((store) => {
      const hook = createPlaybookReflectHook({
        store,
        buildRetrospectInput: retrospectInput,
        getDoomLoopLevel: () => 'none',
      })
      const smooth = createRuntimeHookContext({
        cwd: '/tmp/project',
        turn: 2,
        recentToolHistory: [],
        sensorium: sensorium({ stability: 0.9 }),
        strategy: null,
        vigor: createVigorState({ variability: 0.1 }),
        gitChangeRate: 0,
    season: null,
      })

      hook.run(smooth)

      assert.deepEqual(store.load(), [])
    })
  })
})
