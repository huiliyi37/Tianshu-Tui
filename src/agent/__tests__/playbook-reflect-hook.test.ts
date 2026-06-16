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
import type { SessionRegistry } from '../session-registry.js'

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

type MockFingerprint = { sessionId: string; createdAt: number; rootCauseKeywords: string[]; recommendationKeywords: string[]; stabilityTrend: string; confidenceTrend: string; maxPressure: number; toolFailureRate: number; bulletIds: string[]; projectHash?: string }

function createMockRegistry(fingerprints: MockFingerprint[] = []): SessionRegistry {
  const stored: MockFingerprint[] = []
  return {
    loadFingerprints(limit?: number, excludeSessionId?: string, projectHash?: string) {
      let filtered = fingerprints
        .filter(fp => fp.sessionId !== excludeSessionId)
      if (projectHash) {
        filtered = filtered.filter(fp => fp.projectHash === projectHash)
      }
      return filtered.slice(0, limit ?? 10)
    },
    storeFingerprint(fp: MockFingerprint) {
      stored.push(fp)
    },
    // 其他方法不需要实现
  } as unknown as SessionRegistry
}

describe('createPlaybookReflectHook', () => {
  it('does not store template-only retrospect output (full mode harvests no canned lines)', () => {
    // retrospect.ts sections 3/4 are 100% static template strings, so
    // extractBullets yields nothing real; with no cross-session patterns the
    // hook must store zero bullets rather than persisting boilerplate noise.
    withStore((store) => {
      const phases: Array<{ phase: string; suggestion?: string }> = []
      const registry = createMockRegistry()
      const hook = createPlaybookReflectHook({
        store,
        buildRetrospectInput: retrospectInput,
        getDoomLoopLevel: () => 'blocked',
        registry,
        sessionId: 'test-session',
      })

      hook.run(ctx(phases))

      // Template boilerplate is blocked at the gate → nothing harvested,
      // nothing stored, no phase emitted (hook early-returns).
      assert.equal(store.load().length, 0)
      assert.equal(phases.length, 0)
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

  it('runs in light mode when shouldReflect fails but enough historical fingerprints', () => {
    withStore((store) => {
      const phases: Array<{ phase: string; suggestion?: string }> = []

      // 创建历史指纹（3 个相似 session，都有相同的根因关键词）
      const historical = [
        {
          sessionId: 'sess-1',
          createdAt: Date.now() - 10000,
          rootCauseKeywords: ['验证', '振荡', '策略'],
          recommendationKeywords: ['doom', 'loop'],
          stabilityTrend: 'stable' as const,
          confidenceTrend: 'stable' as const,
          maxPressure: 0.5,
          toolFailureRate: 0,
          bulletIds: ['pb_1'],
        },
        {
          sessionId: 'sess-2',
          createdAt: Date.now() - 5000,
          rootCauseKeywords: ['验证', '振荡', '反馈'],
          recommendationKeywords: ['doom', '阈值'],
          stabilityTrend: 'stable' as const,
          confidenceTrend: 'stable' as const,
          maxPressure: 0.5,
          toolFailureRate: 0,
          bulletIds: ['pb_2'],
        },
        {
          sessionId: 'sess-3',
          createdAt: Date.now() - 2000,
          rootCauseKeywords: ['验证', '振荡', '工具'],
          recommendationKeywords: ['doom', '测试'],
          stabilityTrend: 'stable' as const,
          confidenceTrend: 'stable' as const,
          maxPressure: 0.5,
          toolFailureRate: 0,
          bulletIds: ['pb_3'],
        },
      ]

      const registry = createMockRegistry(historical)

      const hook = createPlaybookReflectHook({
        store,
        buildRetrospectInput: retrospectInput,
        getDoomLoopLevel: () => 'none',
        registry,
        sessionId: 'test-session',
      })

      // 使用光滑 session（shouldReflect 会失败）
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

      // light 模式：当前 fingerprint 的 rootCauseKeywords 是空的（无 retrospect 报告），
      // 所以与历史指纹的相似度会是 0，不会形成模式
      assert.equal(phases.length, 0)
    })
  })

  it('skips when shouldReflect fails and not enough historical fingerprints', () => {
    withStore((store) => {
      const phases: Array<{ phase: string; suggestion?: string }> = []

      // 只有 1 个历史指纹（不够触发 light 模式）
      const historical = [
        {
          sessionId: 'sess-1',
          createdAt: Date.now() - 10000,
          rootCauseKeywords: ['验证', '振荡'],
          recommendationKeywords: ['doom'],
          stabilityTrend: 'stable' as const,
          confidenceTrend: 'stable' as const,
          maxPressure: 0.5,
          toolFailureRate: 0,
          bulletIds: ['pb_1'],
        },
      ]

      const registry = createMockRegistry(historical)

      const hook = createPlaybookReflectHook({
        store,
        buildRetrospectInput: retrospectInput,
        getDoomLoopLevel: () => 'none',
        registry,
        sessionId: 'test-session',
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

      // 应该跳过
      assert.equal(phases.length, 0)
      assert.deepEqual(store.load(), [])
    })
  })

  it('stores fingerprint in registry during full mode', () => {
    withStore((store) => {
      const stored: Array<{ sessionId: string }> = []
      const registry = {
        loadFingerprints: () => [],
        storeFingerprint: (fp: { sessionId: string }) => { stored.push(fp) },
      } as unknown as SessionRegistry

      const hook = createPlaybookReflectHook({
        store,
        buildRetrospectInput: retrospectInput,
        getDoomLoopLevel: () => 'blocked',
        registry,
        sessionId: 'test-session',
      })

      hook.run(ctx())

      assert.equal(stored.length, 1)
      assert.equal(stored[0]!.sessionId, 'test-session')
    })
  })
})
