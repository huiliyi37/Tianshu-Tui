import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDedupGuardHook, trigramOverlap, trigrams } from '../hooks/dedup-guard-hook.js'
import type { RuntimeHookContext, RuntimeHookSnapshot, RuntimeHookEffects } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

function makeCtx(injected: string[]): RuntimeHookContext {
  return {
    snapshot: {} as RuntimeHookSnapshot,
    effects: {
      injectUserMessage: (msg: string) => { injected.push(msg) },
    } as unknown as RuntimeHookEffects,
  }
}

function makeAdvisoryBus(submitted: Array<{ key: string; content: string }>): AdvisoryBus {
  return {
    submit: (entry: { key: string; content: string }) => { submitted.push(entry) },
    drain: () => [],
  } as unknown as AdvisoryBus
}

describe('trigrams', () => {
  it('extracts trigrams from a string', () => {
    const result = trigrams('abcde')
    assert.ok(result.has('abc'))
    assert.ok(result.has('bcd'))
    assert.ok(result.has('cde'))
    assert.equal(result.size, 3)
  })

  it('normalizes whitespace and lowercases', () => {
    const result = trigrams('A  B')
    // "A  B" normalized to "a b" → trigrams: "a b" (length 3, only 1 trigram)
    assert.ok(result.has('a b'))
  })

  it('returns empty set for short strings', () => {
    assert.equal(trigrams('ab').size, 0)
    assert.equal(trigrams('').size, 0)
  })
})

describe('trigramOverlap', () => {
  it('returns 0 for identical short strings', () => {
    // Too short for trigrams
    assert.equal(trigramOverlap('ab', 'ab'), 0)
  })

  it('returns 1 for identical long strings', () => {
    const text = 'this is a longer string with enough characters for trigrams'
    assert.equal(trigramOverlap(text, text), 1)
  })

  it('returns 0 for completely different strings', () => {
    assert.equal(trigramOverlap('abcdefghijklmnopqrstuvwxyz', 'ZYXWVUTSRQPONMLKJIHGFEDCBA'), 0)
  })

  it('returns partial overlap for similar strings', () => {
    const a = 'the quick brown fox jumps over the lazy dog'
    const b = 'the quick brown fox jumps over the lazy cat'
    const overlap = trigramOverlap(a, b)
    assert.ok(overlap > 0.8, `Expected high overlap, got ${overlap}`)
    assert.ok(overlap < 1.0, `Expected less than 1.0, got ${overlap}`)
  })
})

describe('createDedupGuardHook', () => {
  it('does not inject when no previous text exists', () => {
    const injected: string[] = []
    const hook = createDedupGuardHook({
      getStreamedText: () => 'this is some assistant reply text that is long enough',
      getPrevStreamedText: () => null,
      setPrevStreamedText: () => {},
    })
    hook.run(makeCtx(injected))
    assert.equal(injected.length, 0)
  })

  it('does not inject when current text is too short', () => {
    const injected: string[] = []
    const hook = createDedupGuardHook({
      getStreamedText: () => 'short',
      getPrevStreamedText: () => 'previous text that is long enough for comparison purposes',
      setPrevStreamedText: () => {},
    })
    hook.run(makeCtx(injected))
    assert.equal(injected.length, 0)
  })

  it('does not inject when texts are different', () => {
    const injected: string[] = []
    const hook = createDedupGuardHook({
      getStreamedText: () => 'I will now implement the feature by creating a new file and adding tests for it',
      getPrevStreamedText: () => 'The weather is nice today and the birds are singing in the trees outside',
      setPrevStreamedText: () => {},
    })
    hook.run(makeCtx(injected))
    assert.equal(injected.length, 0)
  })

  it('submits dedup advisory when texts are highly similar', () => {
    const injected: string[] = []
    const submitted: Array<{ key: string; content: string }> = []
    const text = 'The implementation consists of three parts: first we create the data model, then we add validation, and finally we write the tests.'
    let stored: string | null = null
    const advisoryBus = makeAdvisoryBus(submitted)
    const hook = createDedupGuardHook({
      getStreamedText: () => text,
      getPrevStreamedText: () => stored,
      setPrevStreamedText: (t) => { stored = t },
      advisoryBus,
    })

    // First turn: stores text, no advisory
    hook.run(makeCtx(injected))
    assert.equal(injected.length, 0)
    assert.equal(submitted.length, 0)
    assert.equal(stored, text)

    // Second turn with same text: submits advisory via advisoryBus
    hook.run(makeCtx(injected))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'dedup-guard')
    assert.ok(submitted[0]!.content.includes('重复输出检测'), `Expected 重复输出检测 in content, got: ${submitted[0]!.content}`)
    assert.ok(submitted[0]!.content.includes('换个角度'), `Expected 换个角度, got: ${submitted[0]!.content}`)
  })

  it('respects custom threshold', () => {
    const injected: string[] = []
    const submitted: Array<{ key: string; content: string }> = []
    const advisoryBus = makeAdvisoryBus(submitted)
    const hook = createDedupGuardHook({
      getStreamedText: () => 'This is a somewhat similar text about programming and software development.',
      getPrevStreamedText: () => 'This is a somewhat similar text about programming and software development.',
      setPrevStreamedText: () => {},
      threshold: 0.99, // Very high threshold
      advisoryBus,
    })
    hook.run(makeCtx(injected))
    // With threshold 0.99 and identical text (overlap = 1.0), advisory should be submitted
    assert.equal(submitted.length, 1)
  })

  it('stores current text for next turn even when no injection', () => {
    const stored: string[] = []
    const hook = createDedupGuardHook({
      getStreamedText: () => 'short',
      getPrevStreamedText: () => null,
      setPrevStreamedText: (t) => { stored.push(t) },
    })
    hook.run(makeCtx([]))
    assert.equal(stored.length, 1)
    assert.equal(stored[0], 'short')
  })
})
