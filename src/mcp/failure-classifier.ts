export type McpErrorClass = 'config' | 'auth' | 'network' | 'protocol' | 'tool_error'

export interface ClassifiedMcpError {
  class: McpErrorClass
  retryable: boolean
  suggestion: string
}

export function classifyMcpError(error: unknown): ClassifiedMcpError {
  const msg = error instanceof Error ? error.message : String(error ?? '')
  const lower = msg.toLowerCase()

  // Config errors
  if (/enoent|invalid json|bad command|spawn.*enoent|cannot find module.*config/i.test(msg)) {
    return { class: 'config', retryable: false, suggestion: 'Check MCP server config: command path, args, and environment.' }
  }

  // Auth errors
  if (/401|403|permission denied|unauthorized|forbidden|scope|oauth|api key/i.test(msg)) {
    return { class: 'auth', retryable: false, suggestion: 'Check API key or OAuth configuration for this MCP server.' }
  }

  // Network errors
  if (/econnrefused|etimedout|socket hang up|econnreset|fetch failed|transport.*close|disconnected/i.test(msg)) {
    return { class: 'network', retryable: true, suggestion: 'Transient network error. Retry may succeed.' }
  }

  // Protocol errors
  if (/invalidparams|invalid params|capability mismatch|malformed|parse error|json-rpc/i.test(msg)) {
    return { class: 'protocol', retryable: false, suggestion: 'Check tool input schema against MCP server definition.' }
  }

  // Default: tool error
  return { class: 'tool_error', retryable: false, suggestion: 'Read the error output for details.' }
}
