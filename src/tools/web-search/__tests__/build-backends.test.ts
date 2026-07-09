import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSearchBackends } from '../build-backends.js'
import type { Config, SearchConfig } from '../../../config/schema.js'

function cfg(search: Partial<SearchConfig>): Config {
  return {
    search: {
      backends: ['duckduckgo'],
      braveApiKeyEnv: 'BRAVE_API_KEY',
      tavilyApiKeyEnv: 'TAVILY_API_KEY',
      timeoutMs: 15_000,
      ...search,
    },
  } as unknown as Config
}

const noopFetch = async () => new Response('')

describe('buildSearchBackends', () => {
  it('builds the default DDG-only chain', () => {
    const backends = buildSearchBackends(cfg({ backends: ['duckduckgo'] }), { fetch: noopFetch, env: {} })
    assert.deepEqual(backends.map(b => b.name), ['duckduckgo'])
  })

  it('preserves config order for the fallback chain', () => {
    const backends = buildSearchBackends(
      cfg({ backends: ['brave', 'tavily', 'duckduckgo'] }),
      { fetch: noopFetch, env: { BRAVE_API_KEY: 'b', TAVILY_API_KEY: 't' } },
    )
    assert.deepEqual(backends.map(b => b.name), ['brave', 'tavily', 'duckduckgo'])
  })

  it('constructs key-backed backends even without a key (availability decided later)', () => {
    const backends = buildSearchBackends(cfg({ backends: ['brave'] }), { fetch: noopFetch, env: {} })
    assert.deepEqual(backends.map(b => b.name), ['brave'])
    assert.equal(backends[0]!.isAvailable(), false, 'brave without key must report unavailable')
  })

  it('marks brave/tavily available when their env keys are present', () => {
    const backends = buildSearchBackends(
      cfg({ backends: ['brave', 'tavily'] }),
      { fetch: noopFetch, env: { BRAVE_API_KEY: 'b', TAVILY_API_KEY: 't' } },
    )
    assert.equal(backends[0]!.isAvailable(), true)
    assert.equal(backends[1]!.isAvailable(), true)
  })

  it('respects custom env var names', () => {
    const backends = buildSearchBackends(
      cfg({ backends: ['brave'], braveApiKeyEnv: 'MY_BRAVE' }),
      { fetch: noopFetch, env: { MY_BRAVE: 'x' } },
    )
    assert.equal(backends[0]!.isAvailable(), true)
  })

  it('skips unknown backend names', () => {
    const backends = buildSearchBackends(cfg({ backends: ['bogus', 'tavily'] }), { fetch: noopFetch, env: { TAVILY_API_KEY: 't' } })
    assert.deepEqual(backends.map(b => b.name), ['tavily'])
  })

  it('falls back to DDG when nothing valid is configured', () => {
    const backends = buildSearchBackends(cfg({ backends: ['bogus'] }), { fetch: noopFetch, env: {} })
    assert.deepEqual(backends.map(b => b.name), ['duckduckgo'])
  })
})
