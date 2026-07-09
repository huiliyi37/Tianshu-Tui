import type { Config } from '../../config/schema.js'
import type { SearchBackend, SearchFetch } from './types.js'
import { DuckDuckGoBackend } from './duckduckgo.js'
import { BraveBackend } from './brave.js'
import { TavilyBackend } from './tavily.js'
import { boundedSearchFetch } from './bounded-fetch.js'

export interface BuildBackendsDeps {
  fetch?: SearchFetch
  env?: NodeJS.ProcessEnv
}

/**
 * Construct the ordered search backend chain from config. API-key backends are
 * always constructed (so their availability is decided at call time by
 * `isAvailable()`), letting a listed-but-unconfigured backend fall through to
 * the next entry. Unknown backend names are skipped. If nothing valid is
 * constructed, DuckDuckGo is added as a zero-config safety net.
 */
export function buildSearchBackends(config: Config, deps: BuildBackendsDeps = {}): SearchBackend[] {
  // Injected test fetches stay as-is; the real global fetch is body-size capped.
  const fetchImpl = deps.fetch ?? boundedSearchFetch(globalThis.fetch.bind(globalThis) as SearchFetch)
  const env = deps.env ?? process.env
  const s = config.search

  const backends: SearchBackend[] = []
  for (const name of s.backends) {
    switch (name) {
      case 'duckduckgo':
        backends.push(new DuckDuckGoBackend(fetchImpl))
        break
      case 'brave':
        backends.push(new BraveBackend(fetchImpl, env[s.braveApiKeyEnv], s.region))
        break
      case 'tavily':
        backends.push(new TavilyBackend(fetchImpl, env[s.tavilyApiKeyEnv]))
        break
      default:
        // Unknown backend name — skip rather than fail the whole chain.
        break
    }
  }

  if (backends.length === 0) {
    backends.push(new DuckDuckGoBackend(fetchImpl))
  }
  return backends
}
