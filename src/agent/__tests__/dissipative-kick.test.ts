import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldKick,
  buildKickActions,
  shouldEscalateFromKick,
} from '../dissipative-kick.js'
import type { Sensorium } from '../sensorium.js'

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.5,
    pressure: 0.3,
    confidence: 0.7,
    complexity: 0.3,
    freshness: 0.5,
    stability: 0.8,
    ...overrides,
  }
}

// ─── shouldKick ─────────────────────────────────────────────────────

describe('shouldKick', () => {
  it('returns false when momentum and stability are healthy', () => {
    const s = makeSensorium({ momentum: 0.6, stability: 0.8 })
    assert.equal(shouldKick(s), false)
  })

  it('returns false when only momentum is low', () => {
    const s = makeSensorium({ momentum: 0.1, stability: 0.8 })
    assert.equal(shouldKick(s), false)
  })

  it('returns false when only stability is low', () => {
    const s = makeSensorium({ momentum: 0.6, stability: 0.2 })
    assert.equal(shouldKick(s), false)
  })

  it('returns true when momentum < 0.2 AND stability < 0.3', () => {
    const s = makeSensorium({ momentum: 0.15, stability: 0.25 })
    assert.equal(shouldKick(s), true)
  })

  it('returns false at exact boundary (momentum=0.2, stability=0.3)', () => {
    const s = makeSensorium({ momentum: 0.2, stability: 0.3 })
    assert.equal(shouldKick(s), false)
  })

  it('returns true for extreme failure state', () => {
    const s = makeSensorium({ momentum: 0, stability: 0 })
    assert.equal(shouldKick(s), true)
  })
})

// ─── buildKickActions ───────────────────────────────────────────────

describe('buildKickActions', () => {
  it('returns deadEndPaths from recentlyFailedFiles', () => {
    const s = makeSensorium()
    const actions = buildKickActions(s, '/project', ['src/bug.ts', 'src/error.ts'])
    assert.deepEqual(actions.deadEndPaths, ['src/bug.ts', 'src/error.ts'])
  })

  it('returns empty deadEndPaths when no files fail', () => {
    const s = makeSensorium()
    const actions = buildKickActions(s, '/project', [])
    assert.deepEqual(actions.deadEndPaths, [])
  })

  it('sets switchToExploration to true', () => {
    const s = makeSensorium()
    const actions = buildKickActions(s, '/project')
    assert.equal(actions.switchToExploration, true)
  })

  it('escalates when confidence very low AND complexity high', () => {
    const s = makeSensorium({ confidence: 0.1, complexity: 0.8 })
    const actions = buildKickActions(s, '/project')
    assert.equal(actions.shouldEscalate, true)
  })

  it('does not escalate when only confidence is low', () => {
    const s = makeSensorium({ confidence: 0.1, complexity: 0.3 })
    const actions = buildKickActions(s, '/project')
    assert.equal(actions.shouldEscalate, false)
  })

  it('does not escalate when only complexity is high', () => {
    const s = makeSensorium({ confidence: 0.5, complexity: 0.8 })
    const actions = buildKickActions(s, '/project')
    assert.equal(actions.shouldEscalate, false)
  })

  it('includes verification suggestion when confidence low', () => {
    const s = makeSensorium({ confidence: 0.2 })
    const actions = buildKickActions(s, '/project')
    assert.ok(actions.injectedMessage.includes('测试验证'))
  })

  it('includes task decomposition suggestion when complexity high', () => {
    const s = makeSensorium({ complexity: 0.7 })
    const actions = buildKickActions(s, '/project')
    assert.ok(actions.injectedMessage.includes('拆分任务'))
  })

  it('includes context pressure suggestion when pressure high', () => {
    const s = makeSensorium({ pressure: 0.8 })
    const actions = buildKickActions(s, '/project')
    assert.ok(actions.injectedMessage.includes('上下文'))
  })

  it('always includes re-read original request suggestion', () => {
    const s = makeSensorium()
    const actions = buildKickActions(s, '/project')
    assert.ok(actions.injectedMessage.includes('原始请求'))
  })

  it('always includes alternative frameworks', () => {
    const s = makeSensorium()
    const actions = buildKickActions(s, '/project')
    assert.ok(actions.alternativeFrameworks.length > 0)
    assert.ok(actions.alternativeFrameworks.includes('simplest viable approach'))
  })

  it('injectedMessage is non-empty string', () => {
    const s = makeSensorium()
    const actions = buildKickActions(s, '/project')
    assert.ok(typeof actions.injectedMessage === 'string')
    assert.ok(actions.injectedMessage.length > 0)
  })
})

// ─── shouldEscalateFromKick ─────────────────────────────────────────

// ─── Loop-consumed action shape ─────────────────────────────────────

describe('buildKickActions integration data', () => {
  it('provides dead-end paths and alternative frameworks for AgentLoop to consume', () => {
    const s = makeSensorium({ momentum: 0.1, stability: 0.2 })
    const actions = buildKickActions(s, '/project', ['src/stuck.ts'])

    assert.deepEqual(actions.deadEndPaths, ['src/stuck.ts'])
    assert.ok(actions.alternativeFrameworks.length > 0)
    assert.ok(actions.injectedMessage.length > 0)

    const fullMessage = `${actions.injectedMessage}\n\n**替代框架：**\n${actions.alternativeFrameworks.map(f => `- ${f}`).join('\n')}`
    assert.ok(fullMessage.includes('simplest viable approach'))
    assert.ok(fullMessage.includes('替代框架'))
  })
})

// ─── shouldEscalateFromKick ─────────────────────────────────────────

describe('shouldEscalateFromKick', () => {
  it('returns true when confidence < 0.2 and complexity > 0.5', () => {
    const s = makeSensorium({ confidence: 0.1, complexity: 0.7 })
    assert.equal(shouldEscalateFromKick(s), true)
  })

  it('returns false when confidence is above threshold', () => {
    const s = makeSensorium({ confidence: 0.3, complexity: 0.7 })
    assert.equal(shouldEscalateFromKick(s), false)
  })

  it('returns false when complexity is below threshold', () => {
    const s = makeSensorium({ confidence: 0.1, complexity: 0.4 })
    assert.equal(shouldEscalateFromKick(s), false)
  })

  it('returns false at exact boundary', () => {
    const s = makeSensorium({ confidence: 0.2, complexity: 0.5 })
    assert.equal(shouldEscalateFromKick(s), false)
  })
})
