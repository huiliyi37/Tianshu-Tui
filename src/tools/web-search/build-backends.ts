import type { Config } from '../../config/schema.js'
import type { ProxyResolverOptions } from '../net/proxy-resolver.js'
import type { SearchBackend, SearchFetch } from './types.js'
import { DuckDuckGoBackend } from './duckduckgo.js'
import { BingBackend } from './bing.js'
import { BraveBackend } from './brave.js'
import { TavilyBackend } from './tavily.js'
import { BochaBackend } from './bocha.js'
import { createProxyAwareFetch } from './proxy-fetch.js'

export interface BuildBackendsDeps {
  fetch?: SearchFetch
  env?: NodeJS.ProcessEnv
  /**
   * Proxy resolution options sourced from `config.network.{proxy,noProxy}`.
   * When present, the production fetch is wrapped via `createProxyAwareFetch`
   * so search traffic honors the same proxy as web_fetch (config.proxy > env >
   * direct). Injected test fetches are passed through untouched — they model
   * synthetic responses and don't go to the network.
   */
  proxy?: ProxyResolverOptions
}

/**
 * Resolve a search backend's API key using the same 3-tier fallback as
 * `api/factory.ts:resolveApiKey` for providers:
 *   1. inline config value `search.<backend>ApiKey`（桌面端 UI 填的明文）
 *   2. explicit env var named by `search.<backend>ApiKeyEnv`
 *   3. standard `<BACKEND>_API_KEY` env var
 *
 * Lets users configure search keys either via the desktop UI (inline, no shell
 * export needed) or via environment variables (CLI/server), mirroring how
 * provider API keys work.
 */
export function resolveSearchKey(
  config: Config,
  env: NodeJS.ProcessEnv,
  backend: 'bocha' | 'brave' | 'tavily',
): string | undefined {
  const s = config.search
  // 1. inline config value（桌面端 UI 填的明文，与 provider.apiKey 同构）
  const inlineKey = s[`${backend}ApiKey` as keyof typeof s]
  if (typeof inlineKey === 'string' && inlineKey.length > 0) return inlineKey
  // 2. 显式 env 变量名（apiKeyEnv 字段，如 BRAVE_API_KEY）
  const envName = s[`${backend}ApiKeyEnv` as keyof typeof s]
  if (typeof envName === 'string' && envName.length > 0) {
    const v = env[envName]
    if (v) return v
  }
  // 3. 标准变量名回退（apiKeyEnv 丢失/手动编辑场景）
  return env[`${backend.toUpperCase()}_API_KEY`]
}

/**
 * Construct the ordered search backend chain from config. API-key backends are
 * always constructed (so their availability is decided at call time by
 * `isAvailable()`), letting a listed-but-unconfigured backend fall through to
 * the next entry. Unknown backend names are skipped. If nothing valid is
 * constructed, DuckDuckGo is added as a zero-config safety net.
 */
export function buildSearchBackends(config: Config, deps: BuildBackendsDeps = {}): SearchBackend[] {
  // Injected test fetches stay as-is; the real global fetch becomes proxy-aware
  // (config.network.proxy > HTTPS_PROXY/HTTP_PROXY env > direct) and is body-size
  // capped via boundedSearchFetch inside createProxyAwareFetch.
  const fetchImpl = deps.fetch ?? createProxyAwareFetch(deps.proxy)
  const env = deps.env ?? process.env

  const backends: SearchBackend[] = []
  for (const name of config.search.backends) {
    switch (name) {
      case 'bing':
        backends.push(new BingBackend(fetchImpl))
        break
      case 'duckduckgo':
        backends.push(new DuckDuckGoBackend(fetchImpl))
        break
      case 'brave':
        backends.push(new BraveBackend(fetchImpl, resolveSearchKey(config, env, 'brave'), config.search.region))
        break
      case 'tavily':
        backends.push(new TavilyBackend(fetchImpl, resolveSearchKey(config, env, 'tavily')))
        break
      case 'bocha':
        // 国内直连 AI 搜索（api.bochaai.com）——Tavily 在国内的替代
        backends.push(new BochaBackend(fetchImpl, resolveSearchKey(config, env, 'bocha')))
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
