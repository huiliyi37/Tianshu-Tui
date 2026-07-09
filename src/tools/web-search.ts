/**
 * web_search — pluggable multi-backend web search.
 *
 * This file is a compatibility shim: the implementation now lives under
 * `./web-search/`. Existing imports (`./web-search.js`) keep working via these
 * re-exports.
 */
export { createWebSearchTool, WEB_SEARCH_TOOL, type WebSearchDeps } from './web-search/tool.js'
export { parseDuckDuckGoResults, decodeHtmlEntities, DuckDuckGoBackend } from './web-search/duckduckgo.js'
export { BraveBackend } from './web-search/brave.js'
export { TavilyBackend } from './web-search/tavily.js'
export { runBackendChain, type ChainResult, type BackendError } from './web-search/chain.js'
export { buildSearchBackends, type BuildBackendsDeps } from './web-search/build-backends.js'
export type { SearchResult, SearchBackend, SearchFetch } from './web-search/types.js'
