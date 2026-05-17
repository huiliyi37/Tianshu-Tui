import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapDeepSeekUsage, resolveCapabilities } from '../provider.js'

describe('DeepSeek provider usage mapping', () => {
  it('maps native DeepSeek cache counters into standard usage fields', () => {
    assert.deepEqual(mapDeepSeekUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 875,
      prompt_cache_miss_tokens: 125,
    }), {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 875,
      cache_creation_input_tokens: 125,
    })
  })

  it('exposes DeepSeek usage mapping through resolved capabilities', () => {
    const capabilities = resolveCapabilities('deepseek')

    assert.deepEqual(capabilities.mapUsage?.({
      prompt_tokens: 400,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 300,
      prompt_cache_miss_tokens: 100,
    }), {
      input_tokens: 400,
      output_tokens: 50,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    })
  })
})
