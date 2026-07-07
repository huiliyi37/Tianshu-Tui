import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOrchestrationScale } from '../task-size-gate.js'

describe('task-size-gate', () => {
  it('blocks typo fix (small signal + short text)', () => {
    const r = classifyOrchestrationScale('fix a typo in config.ts')
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
    assert.ok(r.reason.includes('typo'))
  })

  it('blocks rename (small signal)', () => {
    const r = classifyOrchestrationScale('rename variable x to y')
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
  })

  it('does NOT block refactor (large signal)', () => {
    const r = classifyOrchestrationScale('refactor the entire authentication system')
    assert.equal(r.scale, 'large')
    assert.equal(r.blocked, false)
  })

  it('does NOT block medium-complexity task (no signal, moderate words)', () => {
    const r = classifyOrchestrationScale('implement a new state machine with persistence and web hooks for the notification system')
    assert.equal(r.scale, 'medium')
    assert.equal(r.blocked, false)
  })

  it('blocks very short text (word count threshold)', () => {
    const r = classifyOrchestrationScale('hi')
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
    assert.ok(r.reason.includes('2 words') || r.reason.includes('1 words') || r.reason.includes('small'))
  })

  it('escape hatch bypasses gate', () => {
    const r = classifyOrchestrationScale('force: fix typo in config.ts')
    assert.equal(r.blocked, false)
    assert.ok(r.reason.includes('escape hatch'))
  })

  it('escape hatch: quick prefix also works', () => {
    const r = classifyOrchestrationScale('quick: rename x')
    assert.equal(r.blocked, false)
  })

  it('large signal takes priority over small signal when both present', () => {
    // "refactor" is large, "typo" is small — large wins per priority order
    const r = classifyOrchestrationScale('refactor the typo fix function')
    assert.equal(r.scale, 'large')
    assert.equal(r.blocked, false)
  })

  it('does NOT block long text with small signal (word count > threshold)', () => {
    // Small signal but text is long enough to suggest real context
    const longText = 'fix a typo in the configuration file that was introduced during the last deployment cycle when we migrated from the old config format to the new one with additional validation rules and schema checking across fifty different modules'
    const r = classifyOrchestrationScale(longText)
    // typo is a small signal, but wordCount > 50 → not blocked
    assert.equal(r.blocked, false)
  })

  it('handles Chinese text — short Chinese phrase blocked by word count', () => {
    const r = classifyOrchestrationScale('修一个错字')
    // 5 CJK chars → ceil(5/2) = 3 words → ≤ 15 → small
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
  })

  it('handles Chinese text — long Chinese task not blocked', () => {
    const r = classifyOrchestrationScale('重构整个认证系统的架构，需要跨模块修改认证流程、迁移旧的用户模型到新的类型系统、并添加全面的端到端测试覆盖')
    // Has no English large signals, but word count high enough → not small
    assert.equal(r.blocked, false)
  })

  it('blocks "minor fix" signal', () => {
    const r = classifyOrchestrationScale('minor fix in the parser')
    assert.equal(r.scale, 'small')
    assert.equal(r.blocked, true)
  })

  it('does NOT block "multiple modules" (large signal)', () => {
    const r = classifyOrchestrationScale('update API contracts across multiple modules with backward compatibility')
    assert.equal(r.scale, 'large')
    assert.equal(r.blocked, false)
  })
})
