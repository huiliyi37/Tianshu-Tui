export interface McpConnectionState {
  serverId: string
  status: 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'error'
  transport?: 'stdio' | 'sse'
  toolCount: number
  error?: string
  /** Actionable hint from failure-classifier (shown in UI). */
  errorHint?: string
  lastConnectedAt?: number
  lastErrorClass?: string
  lastErrorAt?: number
}
