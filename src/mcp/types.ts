export interface McpConnectionState {
  serverId: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  toolCount: number
  error?: string
  lastConnectedAt?: number
  lastErrorClass?: string
  lastErrorAt?: number
}
