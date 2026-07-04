import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSuggestPlanMode, buildPlanModeSuggestAdvisory, planModeSuggestEnabled, type PlanModeSuggestInput } from '../plan-mode-advisor.js'
import { extractTaskContract } from '../../context/task-contract.js'

function baseInput(overrides: Partial<PlanModeSuggestInput> = {}): PlanModeSuggestInput {
  const contract = extractTaskContract('重构 src/agent/loop.ts 和 src/tui/app.ts，打通 src/server/session-manager.ts 三个模块', 0)
  return {
    turnMode: 'task',
    contract,
    methodology: 'full',
    depthLayer: 'system',
    planModeState: 'off',
    suggestedContractIds: new Set<string>(),
    ...overrides,
  }
}

describe('shouldSuggestPlanMode', () => {
  it('suggests for a full-methodology task with plan mode off', () => {
    const result = shouldSuggestPlanMode(baseInput())
    assert.equal(result.suggest, true)
    assert.ok(result.reason.length > 0)
  })

  it('does not suggest for lightweight methodology', () => {
    const result = shouldSuggestPlanMode(baseInput({ methodology: 'lightweight' }))
    assert.equal(result.suggest, false)
  })

  it('does not suggest when already in plan mode', () => {
    const result = shouldSuggestPlanMode(baseInput({ planModeState: 'planning' }))
    assert.equal(result.suggest, false)
  })

  it('does not suggest for non-task turn modes', () => {
    assert.equal(shouldSuggestPlanMode(baseInput({ turnMode: 'chat' })).suggest, false)
    assert.equal(shouldSuggestPlanMode(baseInput({ turnMode: 'followUp' })).suggest, false)
  })

  it('does not suggest without an actionable contract', () => {
    const result = shouldSuggestPlanMode(baseInput({ contract: undefined }))
    assert.equal(result.suggest, false)
  })

  it('is one-shot per contract id', () => {
    const input = baseInput()
    const first = shouldSuggestPlanMode(input)
    assert.equal(first.suggest, true)
    const seen = new Set([input.contract!.id])
    const second = shouldSuggestPlanMode({ ...input, suggestedContractIds: seen })
    assert.equal(second.suggest, false)
  })

  it('reason mentions the hit signals (depth / files / refactor)', () => {
    const result = shouldSuggestPlanMode(baseInput())
    assert.ok(/system|文件|重构/.test(result.reason), `reason should carry signals, got: ${result.reason}`)
  })
})

describe('buildPlanModeSuggestAdvisory', () => {
  it('instructs the model to call ask_user_question with the two fixed options', () => {
    const text = buildPlanModeSuggestAdvisory('system 级改动面')
    assert.ok(text.includes('ask_user_question'))
    assert.ok(text.includes('进入计划模式'))
    assert.ok(text.includes('直接执行'))
    assert.ok(text.includes('enter_mode'))
    assert.ok(text.includes('system 级改动面'))
  })
})

describe('planModeSuggestEnabled', () => {
  it('is on by default and off when RIVET_PLAN_MODE_SUGGEST=0', () => {
    const prev = process.env.RIVET_PLAN_MODE_SUGGEST
    try {
      delete process.env.RIVET_PLAN_MODE_SUGGEST
      assert.equal(planModeSuggestEnabled(), true)
      process.env.RIVET_PLAN_MODE_SUGGEST = '0'
      assert.equal(planModeSuggestEnabled(), false)
    } finally {
      if (prev === undefined) delete process.env.RIVET_PLAN_MODE_SUGGEST
      else process.env.RIVET_PLAN_MODE_SUGGEST = prev
    }
  })
})
