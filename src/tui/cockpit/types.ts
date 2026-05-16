export type Panel = 'summary' | 'trace' | 'verify' | 'context' | 'safety' | 'model'

export const PANELS: Panel[] = ['summary', 'trace', 'verify', 'context', 'safety', 'model']

export const PANEL_LABELS: Record<Panel, string> = {
  summary: 'Summary',
  trace: 'Trace',
  verify: 'Verify',
  context: 'Context',
  safety: 'Safety',
  model: 'Model',
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
