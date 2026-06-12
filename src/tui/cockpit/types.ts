import type { PhysarumShadowStats } from '../../repo/physarum-shadow-stats.js'

export type Panel = 'summary' | 'trace' | 'verify' | 'context' | 'safety' | 'model' | 'mcp'

export const PANELS: Panel[] = ['summary', 'trace', 'verify', 'context', 'safety', 'model', 'mcp']

export const PANEL_LABELS: Record<Panel, string> = {
  summary: 'Summary',
  trace: 'Trace',
  verify: 'Verify',
  context: 'Context',
  safety: 'Safety',
  model: 'Model',
  mcp: 'MCP',
}

export interface CockpitContextLayerView {
  id: string
  label: string
  stability: string
  channel: string
  fingerprint: string
  digest: string
  tokenEstimate: number
}

export interface CockpitRiskView {
  level: 'none' | 'low' | 'medium' | 'high'
  reasons: string[]
  suggestedAction: string
}

export interface CockpitVerificationRunView {
  command: string
  status: 'passed' | 'failed' | 'blocked'
  scope: string
  target?: string
}

export interface CockpitVerificationState {
  deliveryStatus: 'verified' | 'failed' | 'blocked' | 'unverified'
  runs: CockpitVerificationRunView[]
}

export type PanelStatus = 'ok' | 'warn' | 'error' | 'idle'

export interface CockpitSnapshot {
  intent: string | null
  blockingReason: string | null
  nextAction: string | null
  safety: {
    doomLoopLevel: 'none' | 'warn' | 'blocked'
    riskLevel: 'none' | 'low' | 'medium' | 'high'
    riskReasons: string[]
    suggestedAction: string
    recentFingerprints: number
  }
  verification: {
    filesRead: number
    filesModified: number
    runs: Array<{ tool: string; status: string; summary: string }>
    deliveryStatus: 'verified' | 'failed' | 'blocked' | 'unverified'
    impactedFiles: number
    impactedTests: number
  }
  trace: {
    events: Array<{
      id: string
      turn: number
      kind: string
      name: string
      status: string
      durationMs?: number
      summary?: string
    }>
    totalEvents: number
  }
  context: {
    estimatedTokens: number
    maxTokens: number
    rounds: number
    compactionState: string
    brokenRounds: number
    layers: CockpitContextLayerView[]
    claimCounts: import('../../context/promotion.js').ClaimStatusCounts
  } | null
  model: {
    name: string
    cacheHitRate: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
    perTurnHitRate: number | null
    recentTurnHitRate: number | null
    prewarmHits: number
    prewarmMisses: number
    prewarmHitRate: number
    physarumShadow: PhysarumShadowStats
    cacheDiagnostic: string | null
    reasoningEffort: string
  }
  mcp: {
    servers: Array<{
      serverId: string
      status: string
      toolCount: number
      lastErrorClass?: string
    }>
    totalTools: number
    connectedServers: number
  }
  panelStatuses: Record<Panel, PanelStatus>
}
