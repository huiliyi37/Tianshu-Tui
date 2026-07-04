import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTanlangExplorationAdvisory, resolveHardStallMs } from '../turn-step-producer.js'

describe('resolveHardStallMs (reasoning-aware watchdog ceiling)', () => {
  it('disables the watchdog for GLM independent reasoning', () => {
    assert.equal(resolveHardStallMs({ providerName: 'glm' }), 0)
    // GLM wins even if effort would otherwise raise the ceiling.
    assert.equal(resolveHardStallMs({ providerName: 'glm', reasoningEffort: 'high' }), 0)
  })

  it('raises the ceiling for deep-reasoning sessions (high/max effort)', () => {
    assert.equal(resolveHardStallMs({ providerName: 'deepseek', reasoningEffort: 'high' }), 480_000)
    assert.equal(resolveHardStallMs({ providerName: 'deepseek', reasoningEffort: 'max' }), 480_000)
  })

  it('keeps the tight default for non-reasoning sessions', () => {
    assert.equal(resolveHardStallMs({ providerName: 'deepseek' }), 240_000)
    assert.equal(resolveHardStallMs({ providerName: 'deepseek', reasoningEffort: 'low' }), 240_000)
    assert.equal(resolveHardStallMs({ providerName: 'deepseek', reasoningEffort: 'medium' }), 240_000)
    assert.equal(resolveHardStallMs({}), 240_000)
  })
})

// B4（将星点亮·贪狼触发面）：勘探/盘点型任务意图 → recall_capsule("贪狼") 指路灯。
describe('buildTanlangExplorationAdvisory (B4 贪狼触发面)', () => {
  it('fires on exploration/inventory keywords', () => {
    for (const input of [
      '帮我勘探一下 physarum 子系统的接线情况',
      '盘点一下仓库里的休眠学习器',
      '做一次架构审计，找出半接的系统',
      '这个模块像是考古现场，帮我看看',
      'find dead code in the repo',
    ]) {
      const advisory = buildTanlangExplorationAdvisory(input)
      assert.ok(advisory, `should fire for: ${input}`)
      assert.ok(advisory!.includes('recall_capsule("贪狼")'), 'points at the capsule recall entry')
      assert.ok(advisory!.startsWith('【贪狼·胶囊】'))
    }
  })

  it('carries the capsule gist when provided', () => {
    const advisory = buildTanlangExplorationAdvisory('勘探架构', '能力勘探/系统联合/不计成本')
    assert.ok(advisory!.includes('能力勘探/系统联合/不计成本'))
  })

  it('stays silent for non-exploration tasks', () => {
    for (const input of [
      '修复 login 页面的空指针',
      '给 buildWorkerPrompt 加一个参数',
      '重构 event-reducer 的 switch',
    ]) {
      assert.equal(buildTanlangExplorationAdvisory(input), null, `should not fire for: ${input}`)
    }
  })
})
