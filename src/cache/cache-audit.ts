export type CacheRiskLevel = 'low' | 'medium' | 'high'

export interface CacheAuditInput {
  changedFiles: string[]
}

export interface CacheAuditFinding {
  file: string
  level: CacheRiskLevel
  reason: string
}

export interface CacheAuditReport {
  level: CacheRiskLevel
  findings: CacheAuditFinding[]
}

function levelRank(level: CacheRiskLevel): number {
  if (level === 'high') return 3
  if (level === 'medium') return 2
  return 1
}

function findingFor(file: string): CacheAuditFinding {
  if (file === 'src/prompt/static.ts') {
    return { file, level: 'high', reason: 'system prompt changes invalidate static prefix' }
  }
  if (file === 'src/prompt/engine.ts') {
    return { file, level: 'high', reason: 'request message layout may change prefix stability' }
  }
  if (file === 'src/agent/compaction-controller.ts') {
    return { file, level: 'high', reason: 'replaceMessages/session split can rewrite history' }
  }
  if (/^src\/tools\/[^/]+\.ts$/.test(file)) {
    return { file, level: 'medium', reason: 'tool result content can change future history' }
  }
  if (/^src\/compact\/[^/]+\.ts$/.test(file)) {
    return { file, level: 'medium', reason: 'pruning or masking can change request payload' }
  }
  return { file, level: 'low', reason: 'no known direct cache risk' }
}

export function auditCacheRisk(input: CacheAuditInput): CacheAuditReport {
  const findings = input.changedFiles.map(findingFor)
  const level = findings.reduce<CacheRiskLevel>(
    (max, f) => (levelRank(f.level) > levelRank(max) ? f.level : max),
    'low',
  )
  return { level, findings }
}
