import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCriteriaExtractionUser,
  extractGoalCriteria,
  GENERIC_SUCCESS_CRITERIA,
  parseCriteria,
  buildCheapClient,
  type CompletionFn,
} from '../goal-criteria.js'
import type { ProviderConfig } from '../../config/schema.js'

describe('parseCriteria', () => {
  it('parses a bare JSON array', () => {
    assert.deepEqual(parseCriteria('["a", "b", "c"]'), ['a', 'b', 'c'])
  })

  it('extracts the array out of surrounding prose and code fences', () => {
    const text = 'Sure! Here are the criteria:\n```json\n["x", "y"]\n```\nDone.'
    assert.deepEqual(parseCriteria(text), ['x', 'y'])
  })

  it('drops non-string and empty entries', () => {
    assert.deepEqual(parseCriteria('["a", 1, "", "  b  ", null]'), ['a', 'b'])
  })

  it('returns null for non-array / unparseable / empty', () => {
    assert.equal(parseCriteria('{"a":1}'), null)
    assert.equal(parseCriteria('not json at all'), null)
    assert.equal(parseCriteria('[]'), null)
    assert.equal(parseCriteria(''), null)
  })
})

describe('buildCriteriaExtractionUser', () => {
  it('embeds the trimmed goal', () => {
    const out = buildCriteriaExtractionUser('  add a feature  ')
    assert.match(out, /Goal:\nadd a feature/)
  })
})

describe('extractGoalCriteria', () => {
  it('returns parsed criteria on a well-formed response', async () => {
    const complete: CompletionFn = async () => '["c1", "c2", "c3"]'
    const out = await extractGoalCriteria('goal', complete)
    assert.deepEqual(out, ['c1', 'c2', 'c3'])
  })

  it('caps criteria at 8', async () => {
    const many = JSON.stringify(Array.from({ length: 12 }, (_, i) => `c${i}`))
    const complete: CompletionFn = async () => many
    const out = await extractGoalCriteria('goal', complete)
    assert.equal(out.length, 8)
  })

  it('falls back to the generic template when the model output is unusable', async () => {
    const complete: CompletionFn = async () => 'no json here'
    const out = await extractGoalCriteria('goal', complete)
    assert.deepEqual(out, [...GENERIC_SUCCESS_CRITERIA])
  })

  it('falls back to the generic template when the call throws', async () => {
    const complete: CompletionFn = async () => { throw new Error('boom') }
    const out = await extractGoalCriteria('goal', complete)
    assert.deepEqual(out, [...GENERIC_SUCCESS_CRITERIA])
  })

  it('forwards the abort signal to the completion fn', async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    const complete: CompletionFn = async (_s, _u, signal) => {
      seen = signal
      return '["ok"]'
    }
    await extractGoalCriteria('goal', complete, ac.signal)
    assert.equal(seen, ac.signal)
  })
})

describe('buildCheapClient', () => {
  it('returns null when provider is not configured', () => {
    const result = buildCheapClient({ provider: 'nonexistent', model: 'm' }, {})
    assert.equal(result, null)
  })

  it('returns null when provider has no apiKey', () => {
    const providers = {
      test: { name: 'test', type: 'openai', models: [{ id: 'm', maxTokens: 4096, contextWindow: 32000 }] },
    }
    const result = buildCheapClient({ provider: 'test', model: 'm' }, providers as unknown as Record<string, ProviderConfig>)
    assert.equal(result, null)
  })

  it('returns null when resolveApiKey throws', () => {
    // Provider exists but apiKey is explicitly empty — resolveApiKey throws
    const providers = {
      test: { name: 'test', type: 'openai', apiKey: '', models: [{ id: 'm', maxTokens: 4096, contextWindow: 32000 }] },
    }
    const result = buildCheapClient({ provider: 'test', model: 'm' }, providers as unknown as Record<string, ProviderConfig>)
    assert.equal(result, null)
  })
})
