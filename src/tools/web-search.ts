import type { Tool, ToolCallParams, ToolResult } from './types.js'

const DEFINITION = {
  name: 'web_search',
  description: 'Search the web for real-time information. Results include titles, URLs, and content summaries from search engines.',
  providerFormat: {
    type: 'web_search',
    web_search: {
      enable: true,
      search_engine: 'search_pro_quark',
      search_result: true,
      count: 50,
      content_size: 'high',
    },
  },
}

export const WEB_SEARCH_TOOL: Tool = {
  definition: DEFINITION,
  async execute(_params: ToolCallParams): Promise<ToolResult> {
    return { content: '' }
  },
  requiresApproval(): boolean {
    return false
  },
  isConcurrencySafe(): boolean {
    return true
  },
  isEnabled(): boolean {
    return true
  },
}
