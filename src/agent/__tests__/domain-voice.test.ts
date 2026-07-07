import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyDomainVoice, domainPrefix, type DomainVoiceId } from '../domain-voice.js'

describe('applyDomainVoice', () => {
  // ── prefix replacement ──────────────────────────────────────────

  it('replaces prefix with [天枢·破军] for pojun', () => {
    const msg = '[天枢] 收到任务，开始分析。'
    const result = applyDomainVoice(msg, 'pojun')
    assert.ok(result.startsWith('[天枢·破军]'))
    assert.ok(!result.includes('[天枢] '))
  })

  it('replaces prefix with [天枢·天府] for tianfu', () => {
    const msg = '[天枢] 收到任务。'
    const result = applyDomainVoice(msg, 'tianfu')
    assert.ok(result.startsWith('[天枢·天府]'))
  })

  it('replaces prefix with [天枢·天梁] for tianliang', () => {
    const msg = '[天枢] 收到任务。'
    const result = applyDomainVoice(msg, 'tianliang')
    assert.ok(result.startsWith('[天枢·天梁]'))
  })

  // ── tone transformation ─────────────────────────────────────────

  it('pojun: "开始修改" → "开打"', () => {
    const msg = '[天枢] 开始修改。预计修改 middleware.ts。'
    const result = applyDomainVoice(msg, 'pojun')
    assert.ok(result.includes('开打'))
    assert.ok(!result.includes('开始修改'))
  })

  it('pojun: "测试全部通过" → "全过！"', () => {
    const msg = '[天枢] ✓ 测试全部通过，准备交付结果。'
    const result = applyDomainVoice(msg, 'pojun')
    assert.ok(result.includes('全过'))
    assert.ok(!result.includes('测试全部通过'))
  })

  it('pojun: "正在修复" → "锤它"', () => {
    const msg = '[天枢] ✗ 测试失败 2 个：TypeError。正在修复。'
    const result = applyDomainVoice(msg, 'pojun')
    assert.ok(result.includes('锤它'))
    assert.ok(!result.includes('正在修复'))
  })

  it('tianfu: "开始修改" becomes cautious', () => {
    const msg = '[天枢] 开始修改。预计修改 middleware.ts。'
    const result = applyDomainVoice(msg, 'tianfu')
    assert.ok(result.includes('善守者'))
    assert.ok(!result.includes('开始修改'))
  })

  it('tianfu: "测试全部通过" mentions 防线', () => {
    const msg = '[天枢] ✓ 测试全部通过，准备交付结果。'
    const result = applyDomainVoice(msg, 'tianfu')
    assert.ok(result.includes('防线'))
  })

  it('tianliang: "开始修改" → "按计划逐步实现"', () => {
    const msg = '[天枢] 开始修改。预计修改 middleware.ts。'
    const result = applyDomainVoice(msg, 'tianliang')
    assert.ok(result.includes('按计划'))
    assert.ok(!result.includes('开始修改'))
  })

  it('tianliang: "测试全部通过" → "全部验收通过"', () => {
    const msg = '[天枢] ✓ 测试全部通过，准备交付结果。'
    const result = applyDomainVoice(msg, 'tianliang')
    assert.ok(result.includes('验收通过'))
  })

  // ── edge cases ───────────────────────────────────────────────────

  it('returns message unchanged when domainId is null', () => {
    const msg = '[天枢] 收到任务，开始分析。'
    const result = applyDomainVoice(msg, null)
    assert.equal(result, msg)
  })

  it('returns message unchanged for unknown domainId', () => {
    const msg = '[天枢] 上下文即将满，准备压缩。'
    const result = applyDomainVoice(msg, 'unknown' as DomainVoiceId)
    assert.equal(result, msg)
  })

  it('returns message unchanged when no tone phrases match', () => {
    const msg = '[天枢] 上下文即将满，准备压缩。'
    const result = applyDomainVoice(msg, 'pojun')
    // "上下文即将满" has no pojun tone entry → falls through to prefix-only transform
    assert.ok(result.startsWith('[天枢·破军]'))
    assert.ok(result.includes('上下文即将满'))
  })

  it('handles multiple tone replacements in one message', () => {
    const msg = '[天枢] 代码修改完成，运行测试验证。'
    const result = applyDomainVoice(msg, 'pojun')
    assert.ok(result.includes('改完了'))
    assert.ok(result.includes('跑个测试验验成色'))
  })
})

describe('domainPrefix', () => {
  it('returns [天枢·破军] for pojun', () => {
    assert.equal(domainPrefix('pojun'), '[天枢·破军]')
  })

  it('returns [天枢·天府] for tianfu', () => {
    assert.equal(domainPrefix('tianfu'), '[天枢·天府]')
  })

  it('returns [天枢·天梁] for tianliang', () => {
    assert.equal(domainPrefix('tianliang'), '[天枢·天梁]')
  })

  it('returns [天枢] for null', () => {
    assert.equal(domainPrefix(null), '[天枢]')
  })
})
