export interface McpConnectionState {
  serverId: string
  status: 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'error'
  transport?: 'stdio' | 'sse'
  toolCount: number
  error?: string
  lastConnectedAt?: number
  lastErrorClass?: string
  lastErrorAt?: number
}
