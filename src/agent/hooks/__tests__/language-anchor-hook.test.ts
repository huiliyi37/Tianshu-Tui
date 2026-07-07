import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createLanguageAnchorHook, countCjkChars } from '../language-anchor-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/fake',
      turn,
      recentToolHistory: [],
      sensorium: null,
    },
    effects: {},
  } as unknown as RuntimeHookContext
}

function makeTool(resultContent: string): RuntimeToolEvent {
  return {
    name: 'read_file',
    success: true,
    resultContent,
  } as unknown as RuntimeToolEvent
}

const ENGLISH_10K = 'export function foo(bar: string): number { return bar.length } // impl\n'.repeat(150) // ~10.6K chars
const CHINESE_BLOCK = '这是一段中文说明，用于校验语言锚定钩子的CJK占比统计逻辑。'.repeat(120) // ~3.4K CJK chars

describe('countCjkChars', () => {
  it('counts CJK ideographs and fullwidth punctuation', () => {
    assert.equal(countCjkChars('hello world'), 0)
    assert.equal(countCjkChars('中文'), 2)
    assert.equal(countCjkChars('中文，标点。'), 6)
    assert.equal(countCjkChars('mixed 中 text 文'), 2)
  })
})

describe('createLanguageAnchorHook', () => {
  it('fires once cumulative non-CJK content crosses the threshold', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createLanguageAnchorHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    assert.equal(submitted.length, 0, 'below 15K threshold — must not fire yet')
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    assert.equal(submitted.length, 1, 'cumulative ~21K English — must fire')
    assert.equal(submitted[0]!.key, 'language-anchor')
    assert.equal(submitted[0]!.category, 'discipline')
    assert.match(submitted[0]!.content, /中文/)
  })

  it('does not fire when CJK ratio is above the floor', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createLanguageAnchorHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    // ~21K English + ~3.4K Chinese → CJK ratio ~14% > 5% floor
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    hook.run(makeCtx(1), makeTool(CHINESE_BLOCK))
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    assert.equal(submitted.length, 0)
  })

  it('fires at most once per turn', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createLanguageAnchorHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    assert.equal(submitted.length, 1)
  })

  it('resets the accumulator on a new turn', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createLanguageAnchorHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    hook.run(makeCtx(2), makeTool(ENGLISH_10K))
    assert.equal(submitted.length, 0, 'accumulation must not carry across turns')
    hook.run(makeCtx(2), makeTool(ENGLISH_10K))
    assert.equal(submitted.length, 1, 'same-turn accumulation still works after reset')
  })

  it('can fire again in a later turn', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createLanguageAnchorHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    hook.run(makeCtx(1), makeTool(ENGLISH_10K))
    hook.run(makeCtx(2), makeTool(ENGLISH_10K))
    hook.run(makeCtx(2), makeTool(ENGLISH_10K))
    assert.equal(submitted.length, 2)
  })

  it('ignores tools without result content', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createLanguageAnchorHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      thresholdChars: 10,
    })
    hook.run(makeCtx(1), { name: 'todo', success: true } as unknown as RuntimeToolEvent)
    assert.equal(submitted.length, 0)
  })

  it('respects custom threshold and ratio floor', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createLanguageAnchorHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      thresholdChars: 100,
      cjkRatioFloor: 0.5,
    })
    // 120 chars English, 0% CJK < 50% floor → fires at the 100-char threshold
    hook.run(makeCtx(1), makeTool('x'.repeat(120)))
    assert.equal(submitted.length, 1)
  })
})
