export interface McpConnectionState {
  serverId: string
  status: 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'error'
  toolCount: number
  error?: string
  lastConnectedAt?: number
  lastErrorClass?: string
  lastErrorAt?: number
}
