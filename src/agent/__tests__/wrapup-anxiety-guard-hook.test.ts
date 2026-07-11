import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWrapupAnxietyGuardHook, detectWrapupPhrase } from '../hooks/wrapup-anxiety-guard-hook.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryEntry } from '../advisory-bus.js'

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: { turn, cwd: '/proj', recentToolHistory: [] },
    effects: {},
  } as unknown as RuntimeHookContext
}

function setup(opts: { text: string; estimated: number; window: number }) {
  const submitted: AdvisoryEntry[] = []
  const hook = createWrapupAnxietyGuardHook({
    advisoryBus: { submit: s => { submitted.push(s) } },
    getStreamedText: () => opts.text,
    getEstimatedTokens: () => opts.estimated,
    getContextWindow: () => opts.window,
  })
  return { submitted, run: (turn: number) => hook.run(makeCtx(turn)) }
}

describe('detectWrapupPhrase — 正则两组', () => {
  it('matches direct phrasings', () => {
    for (const text of [
      '上下文压力较大，我先总结一下。',
      '上下文快满了。',
      '建议开新会话继续。',
      '建议新会话处理后续。',
      '先交付这部分，其余稍后。',
      '受限于篇幅，只列要点。',
    ]) {
      assert.ok(detectWrapupPhrase(text), `expected match: ${text}`)
    }
  })

  it('matches indirect phrasings (session 20b9714e evidence)', () => {
    for (const text of [
      '剩余 T3-T6 交给新会话实施。',
      '余下的工作放到新会话处理。',
      '剩下几项建议放入新会话。',
      '新会话继续实施后面的任务。',
      '新会话接手更稳妥。',
      '这些留给新会话完成。',
    ]) {
      assert.ok(detectWrapupPhrase(text), `expected match: ${text}`)
    }
  })

  it('does not match normal text', () => {
    for (const text of [
      '测试通过，全部任务完成。',
      '会话日志显示上一轮工具调用成功。',
      '新会话 ID 的格式是 worker-<uuid>。', // 无"继续/实施/接手/完成"动词跟随
      '上下文里可能出现多个 context-update 块。',
    ]) {
      assert.equal(detectWrapupPhrase(text), null, `expected no match: ${text}`)
    }
  })

  it('indirect pattern stays within one sentence (no cross-sentence match)', () => {
    // "剩余"与"新会话"分属两句 —— 不应命中间接组；且无其他直接措辞
    const text = '剩余测试全部通过。后续如果用户想开新会话再说。'
    assert.equal(detectWrapupPhrase(text), null)
  })
})

describe('wrapup-anxiety-guard — 三段 ctxRatio 阈值', () => {
  const anxious = 'T0-T2 已完成并通过测试。考虑到进度与复杂度，剩余 T3-T6 交给新会话实施更稳妥。'

  it('refutes when ratio < 0.5 (anxiety not grounded in facts)', () => {
    const h = setup({ text: anxious, estimated: 100_000, window: 1_000_000 }) // 10%
    h.run(1)
    assert.equal(h.submitted.length, 1)
    const adv = h.submitted[0]!
    assert.equal(adv.key, 'wrapup-anxiety-guard')
    assert.ok(adv.content.includes('10%'), 'must cite the measured ratio')
    assert.ok(adv.content.includes('1M'), 'must cite the window size')
    assert.ok(adv.content.includes('session_vitals'))
  })

  it('stays silent in the grey zone (0.5 <= ratio < 0.7)', () => {
    const h = setup({ text: anxious, estimated: 600_000, window: 1_000_000 }) // 60%
    h.run(1)
    assert.equal(h.submitted.length, 0, 'grey zone: neither refute nor endorse')
  })

  it('stays silent at high pressure (ratio >= 0.7 — wrap-up advice is legitimate)', () => {
    const h = setup({ text: anxious, estimated: 750_000, window: 1_000_000 }) // 75%
    h.run(1)
    assert.equal(h.submitted.length, 0)
  })

  it('stays silent when no wrap-up phrase present', () => {
    const h = setup({ text: '继续实施 W3，测试全绿。', estimated: 100_000, window: 1_000_000 })
    h.run(1)
    assert.equal(h.submitted.length, 0)
  })

  it('applies cooldown between fires', () => {
    const h = setup({ text: anxious, estimated: 100_000, window: 1_000_000 })
    h.run(1)
    h.run(2)
    h.run(3)
    assert.equal(h.submitted.length, 1, 'default 5-turn cooldown suppresses turns 2-3')
    h.run(6)
    assert.equal(h.submitted.length, 2, 'fires again after cooldown')
  })

  it('stays silent when token metrics are unavailable', () => {
    const h = setup({ text: anxious, estimated: 0, window: 1_000_000 })
    h.run(1)
    assert.equal(h.submitted.length, 0)
  })
})
