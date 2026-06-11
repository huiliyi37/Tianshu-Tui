import type { GatedInfluenceAuditEvent, GatedInfluenceSource } from './gated-influence-audit.js'
import type { TeamScopeHealthSeverity } from './team-scope-health.js'

export type SwitchRecommendation =
  | 'keep_shadow_only'
  | 'allow_manual_opt_in'
  | 'allow_limited_default_on'
  | 'disable_and_investigate'

export interface GatedInfluenceEvaluationStore {
  loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }>
}

export interface InfluenceEvaluationMetrics {
  source: GatedInfluenceSource
  totalShadowSamples: number
  gateOpenCount: number
  appliedCount: number
  vetoCounts: Record<string, number>
  averageRewardByCandidate: Record<string, number>
  falseGreenRate?: number
  scopeLeakRate?: number
  worstScopeSeverity?: TeamScopeHealthSeverity
  ruleAgreementRate?: number
  regretEstimate?: number
  recommendation: SwitchRecommendation
  recommendationReason: string
}

export interface GatedInfluenceEvaluationReport {
  schemaVersion: 1
  generatedAt: number
  malformedRows: number
  sources: Record<GatedInfluenceSource, InfluenceEvaluationMetrics>
}

interface EvaluationOptions {
  limitPerPrefix?: number
  generatedAt?: number
}

interface Accumulator {
  total: number
  count: number
}

const SOURCES: GatedInfluenceSource[] = [
  'team_scheduler_bandit',
  'model_tier_bandit',
  'model_routing',
  'plan_cache_advisory',
  'physarum_supervision',
  'effort_bandit',
]

const MIN_SAMPLES: Record<GatedInfluenceSource, number> = {
  team_scheduler_bandit: 30,
  model_tier_bandit: 30,
  model_routing: 30,
  plan_cache_advisory: 20,
  physarum_supervision: 20,
  effort_bandit: 30,
}

const SEVERITY_RANK: Record<TeamScopeHealthSeverity, number> = {
  healthy: 0,
  low: 1,
  medium: 2,
  high: 3,
}

function emptyMetrics(source: GatedInfluenceSource): InfluenceEvaluationMetrics {
  return {
    source,
    totalShadowSamples: 0,
    gateOpenCount: 0,
    appliedCount: 0,
    vetoCounts: {},
    averageRewardByCandidate: {},
    recommendation: 'keep_shadow_only',
    recommendationReason: 'insufficient samples',
  }
}

function parseJson<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function finiteUnit(value: unknown): number | undefined {
  const number = finiteNumber(value)
  if (number === undefined) return undefined
  return Math.max(0, Math.min(1, number))
}

function booleanComponent(components: Record<string, unknown>, key: string): boolean {
  return components[key] === true
}

function stringComponent(components: Record<string, unknown>, key: string): string | undefined {
  const value = components[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function parseScopeSeverity(value: unknown): TeamScopeHealthSeverity | undefined {
  return value === 'healthy' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined
}

function updateWorst(current: TeamScopeHealthSeverity | undefined, next: TeamScopeHealthSeverity | undefined): TeamScopeHealthSeverity | undefined {
  if (!next) return current
  if (!current) return next
  return SEVERITY_RANK[next] > SEVERITY_RANK[current] ? next : current
}

function average(acc: Accumulator | undefined): number | undefined {
  if (!acc || acc.count === 0) return undefined
  return Math.round((acc.total / acc.count) * 1_000_000) / 1_000_000
}

function add(accs: Map<string, Accumulator>, key: string, value: number): void {
  const current = accs.get(key) ?? { total: 0, count: 0 }
  current.total += value
  current.count += 1
  accs.set(key, current)
}

function chooseRecommendation(metrics: InfluenceEvaluationMetrics): Pick<InfluenceEvaluationMetrics, 'recommendation' | 'recommendationReason'> {
  const minSamples = MIN_SAMPLES[metrics.source]
  if ((metrics.falseGreenRate ?? 0) > 0) {
    return { recommendation: 'disable_and_investigate', recommendationReason: 'false-green observed; investigate before enabling' }
  }
  if (metrics.worstScopeSeverity === 'high' || metrics.worstScopeSeverity === 'medium') {
    return { recommendation: 'disable_and_investigate', recommendationReason: `scope-health veto ${metrics.worstScopeSeverity}` }
  }
  if (metrics.totalShadowSamples < minSamples) {
    return { recommendation: 'keep_shadow_only', recommendationReason: `insufficient samples ${metrics.totalShadowSamples}/${minSamples}` }
  }
  if (metrics.scopeLeakRate === undefined && (metrics.source === 'team_scheduler_bandit' || metrics.source === 'model_tier_bandit')) {
    return { recommendation: 'keep_shadow_only', recommendationReason: 'scope health unknown; keep shadow-only until observed-first scope evidence exists' }
  }
  if (metrics.source === 'model_routing' || metrics.source === 'plan_cache_advisory' || metrics.source === 'physarum_supervision') {
    return { recommendation: 'keep_shadow_only', recommendationReason: 'path is explicitly shadow/advisory/one-way only' }
  }
  if (metrics.appliedCount === 0 && metrics.gateOpenCount > 0) {
    return { recommendation: 'allow_manual_opt_in', recommendationReason: 'gateOpen evidence exists but applied evidence is absent' }
  }
  if (metrics.appliedCount > 0 && (metrics.regretEstimate ?? 0) > 0.05) {
    return { recommendation: 'allow_manual_opt_in', recommendationReason: 'positive gated evidence; keep manual opt-in until stronger applied history accumulates' }
  }
  return { recommendation: 'keep_shadow_only', recommendationReason: 'no positive gated effect established' }
}

function finalize(metrics: InfluenceEvaluationMetrics): InfluenceEvaluationMetrics {
  return { ...metrics, ...chooseRecommendation(metrics) }
}

export function evaluateGatedInfluenceHistory(
  store: GatedInfluenceEvaluationStore | undefined | null,
  options: EvaluationOptions = {},
): GatedInfluenceEvaluationReport {
  const metrics = Object.fromEntries(SOURCES.map(source => [source, emptyMetrics(source)])) as Record<GatedInfluenceSource, InfluenceEvaluationMetrics>
  let malformedRows = 0
  const limit = options.limitPerPrefix ?? 500
  if (!store?.loadBanditStatesByPrefix) {
    return {
      schemaVersion: 1,
      generatedAt: options.generatedAt ?? Date.now(),
      malformedRows,
      sources: Object.fromEntries(SOURCES.map(source => [source, finalize(metrics[source])])) as Record<GatedInfluenceSource, InfluenceEvaluationMetrics>,
    }
  }

  const schedulerRewards = new Map<string, Accumulator>()
  const tierRewards = new Map<string, Accumulator>()
  const routingRewards = new Map<string, Accumulator>()
  let schedulerFalseGreen = 0
  let schedulerRewardSamples = 0
  let schedulerScopeLeakTotal = 0
  let schedulerScopeLeakSamples = 0
  let tierFalseGreen = 0
  let tierRewardSamples = 0
  let tierScopeLeakTotal = 0
  let tierScopeLeakSamples = 0

  for (const row of store.loadBanditStatesByPrefix('team_scheduler_shadow:', limit)) {
    const parsed = parseJson<{ schemaVersion?: unknown; recommendedArm?: unknown; ruleParallelism?: unknown }>(row.json)
    if (parsed?.schemaVersion !== 1 || typeof parsed.recommendedArm !== 'string') { malformedRows++; continue }
    metrics.team_scheduler_bandit.totalShadowSamples++
    if (finiteNumber(parsed.ruleParallelism) !== undefined) {
      const rec = Number.parseInt(parsed.recommendedArm.split(':')[1] ?? '', 10)
      const rule = finiteNumber(parsed.ruleParallelism)!
      if (Number.isFinite(rec)) {
        const current = metrics.team_scheduler_bandit.ruleAgreementRate ?? 0
        const count = metrics.team_scheduler_bandit.totalShadowSamples
        metrics.team_scheduler_bandit.ruleAgreementRate = ((current * (count - 1)) + (rec <= rule ? 1 : 0)) / count
      }
    }
  }

  for (const row of store.loadBanditStatesByPrefix('model_tier_shadow:', limit)) {
    const parsed = parseJson<{ schemaVersion?: unknown; recommendedTier?: unknown; matched?: unknown }>(row.json)
    if (parsed?.schemaVersion !== 1 || typeof parsed.recommendedTier !== 'string') { malformedRows++; continue }
    metrics.model_tier_bandit.totalShadowSamples++
    const current = metrics.model_tier_bandit.ruleAgreementRate ?? 0
    const count = metrics.model_tier_bandit.totalShadowSamples
    metrics.model_tier_bandit.ruleAgreementRate = ((current * (count - 1)) + (parsed.matched === true ? 1 : 0)) / count
  }

  for (const row of store.loadBanditStatesByPrefix('routing_shadow:', limit)) {
    const parsed = parseJson<{ schemaVersion?: unknown }>(row.json)
    if (parsed?.schemaVersion !== 1) { malformedRows++; continue }
    metrics.model_routing.totalShadowSamples++
  }

  for (const row of store.loadBanditStatesByPrefix('team_physarum_supervision:', limit)) {
    const parsed = parseJson<{ schemaVersion?: unknown; applied?: unknown; safeToApply?: unknown; scopeSeverity?: unknown }>(row.json)
    if (parsed?.schemaVersion !== 1) { malformedRows++; continue }
    metrics.physarum_supervision.totalShadowSamples++
    if (parsed.applied === true) metrics.physarum_supervision.appliedCount++
    metrics.physarum_supervision.worstScopeSeverity = updateWorst(metrics.physarum_supervision.worstScopeSeverity, parseScopeSeverity(parsed.scopeSeverity))
  }

  for (const row of store.loadBanditStatesByPrefix('team_scheduler_reward:', limit)) {
    const parsed = parseJson<{ schemaVersion?: unknown; arm?: unknown; reward?: unknown; components?: Record<string, unknown> }>(row.json)
    const reward = finiteNumber(parsed?.reward)
    if (parsed?.schemaVersion !== 1 || typeof parsed.arm !== 'string' || reward === undefined) { malformedRows++; continue }
    add(schedulerRewards, parsed.arm, reward)
    schedulerRewardSamples++
    if (booleanComponent(parsed.components ?? {}, 'falseGreen')) schedulerFalseGreen++
    const scopeLeak = finiteUnit(parsed.components?.scopeLeakRate)
    if (scopeLeak !== undefined) { schedulerScopeLeakTotal += scopeLeak; schedulerScopeLeakSamples++ }
  }

  for (const prefix of ['reward_closure:team_wave:', 'reward_closure:team_episode:'] as const) {
    for (const row of store.loadBanditStatesByPrefix(prefix, limit)) {
      const parsed = parseJson<{ schemaVersion?: unknown; sourceKind?: unknown; reward?: unknown; components?: Record<string, unknown> }>(row.json)
      const reward = finiteNumber(parsed?.reward)
      if (parsed?.schemaVersion !== 1 || reward === undefined || !parsed.components) { malformedRows++; continue }
      const tier = stringComponent(parsed.components, 'workerTier') ?? stringComponent(parsed.components, 'selectedTier')
      if (tier) add(tierRewards, tier, reward)
      tierRewardSamples++
      if (booleanComponent(parsed.components, 'falseGreen')) tierFalseGreen++
      const scopeLeak = finiteUnit(parsed.components.normalizedScopeLeak)
      if (scopeLeak !== undefined) { tierScopeLeakTotal += scopeLeak; tierScopeLeakSamples++ }
      metrics.model_tier_bandit.worstScopeSeverity = updateWorst(metrics.model_tier_bandit.worstScopeSeverity, parseScopeSeverity(parsed.components.scopeSeverity))
    }
  }

  for (const row of store.loadBanditStatesByPrefix('reward_closure:routing_shadow:', limit)) {
    const parsed = parseJson<{ schemaVersion?: unknown; reward?: unknown; components?: Record<string, unknown> }>(row.json)
    const reward = finiteNumber(parsed?.reward)
    if (parsed?.schemaVersion !== 1 || reward === undefined || !parsed.components) { malformedRows++; continue }
    const model = stringComponent(parsed.components, 'recommendedModel') ?? 'unknown'
    add(routingRewards, model, reward)
  }

  for (const row of store.loadBanditStatesByPrefix('team_scope_health:', limit)) {
    const parsed = parseJson<{ schemaVersion?: unknown; severity?: unknown; scopeLeakRate?: unknown }>(row.json)
    if (parsed?.schemaVersion !== 1) { malformedRows++; continue }
    const severity = parseScopeSeverity(parsed.severity)
    metrics.team_scheduler_bandit.worstScopeSeverity = updateWorst(metrics.team_scheduler_bandit.worstScopeSeverity, severity)
    metrics.model_tier_bandit.worstScopeSeverity = updateWorst(metrics.model_tier_bandit.worstScopeSeverity, severity)
    const leak = finiteUnit(parsed.scopeLeakRate)
    if (leak !== undefined) {
      schedulerScopeLeakTotal += leak; schedulerScopeLeakSamples++
      tierScopeLeakTotal += leak; tierScopeLeakSamples++
    }
  }

  for (const source of SOURCES) {
    for (const row of store.loadBanditStatesByPrefix(`gated_influence_audit:${source}:`, limit)) {
      const parsed = parseJson<Partial<GatedInfluenceAuditEvent>>(row.json)
      if (parsed?.schemaVersion !== 1 || parsed.source !== source || typeof parsed.gateOpen !== 'boolean' || typeof parsed.applied !== 'boolean') { malformedRows++; continue }
      if (parsed.gateOpen) metrics[source].gateOpenCount++
      if (parsed.applied) metrics[source].appliedCount++
      for (const veto of parsed.vetoSignals ?? []) {
        metrics[source].vetoCounts[veto] = (metrics[source].vetoCounts[veto] ?? 0) + 1
      }
      const rewardMargin = finiteNumber(parsed.evidenceWindow?.rewardMargin)
      if (rewardMargin !== undefined) {
        metrics[source].regretEstimate = Math.round(Math.max(metrics[source].regretEstimate ?? Number.NEGATIVE_INFINITY, rewardMargin) * 1_000_000) / 1_000_000
      }
    }
  }

  for (const [key, acc] of schedulerRewards) metrics.team_scheduler_bandit.averageRewardByCandidate[key] = average(acc)!
  for (const [key, acc] of tierRewards) metrics.model_tier_bandit.averageRewardByCandidate[key] = average(acc)!
  for (const [key, acc] of routingRewards) metrics.model_routing.averageRewardByCandidate[key] = average(acc)!
  if (schedulerRewardSamples > 0) metrics.team_scheduler_bandit.falseGreenRate = schedulerFalseGreen / schedulerRewardSamples
  if (schedulerScopeLeakSamples > 0) metrics.team_scheduler_bandit.scopeLeakRate = Math.round((schedulerScopeLeakTotal / schedulerScopeLeakSamples) * 1_000_000) / 1_000_000
  if (tierRewardSamples > 0) metrics.model_tier_bandit.falseGreenRate = tierFalseGreen / tierRewardSamples
  if (tierScopeLeakSamples > 0) metrics.model_tier_bandit.scopeLeakRate = Math.round((tierScopeLeakTotal / tierScopeLeakSamples) * 1_000_000) / 1_000_000

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? Date.now(),
    malformedRows,
    sources: Object.fromEntries(SOURCES.map(source => [source, finalize(metrics[source])])) as Record<GatedInfluenceSource, InfluenceEvaluationMetrics>,
  }
}

function fmt(value: unknown): string {
  if (value === undefined) return 'unknown'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return String(value)
}

export function renderGatedInfluenceEvaluationMarkdown(report: GatedInfluenceEvaluationReport): string {
  const lines = [
    '# T5 收官偏差验收报告',
    '',
    `生成时间戳：${report.generatedAt}`,
    `坏行/忽略行：${report.malformedRows}`,
    '',
    '| 路径 | shadow样本 | gateOpen | applied | falseGreenRate | scopeLeakRate | worstScope | regretEstimate | 建议 | 理由 |',
    '|---|---:|---:|---:|---:|---:|---|---:|---|---|',
  ]
  for (const source of SOURCES) {
    const m = report.sources[source]
    lines.push(`| ${source} | ${m.totalShadowSamples} | ${m.gateOpenCount} | ${m.appliedCount} | ${fmt(m.falseGreenRate)} | ${fmt(m.scopeLeakRate)} | ${fmt(m.worstScopeSeverity)} | ${fmt(m.regretEstimate)} | ${m.recommendation} | ${m.recommendationReason} |`)
  }
  lines.push('', '## 继续观测项', '')
  for (const source of SOURCES) {
    const m = report.sources[source]
    lines.push(`- ${source}: veto=${JSON.stringify(m.vetoCounts)}, rewardByCandidate=${JSON.stringify(m.averageRewardByCandidate)}`)
  }
  lines.push('', '> 本报告只记录事实、样本数和开关建议；不声称已经证明智能提升。')
  return lines.join('\n')
}
