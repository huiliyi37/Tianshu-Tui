import type { AgentLoop } from '../../agent/loop.js'
import type { SessionContext } from '../../agent/context.js'
import { buildDeliveryGate } from '../../agent/delivery-gate.js'
import type { McpManager } from '../../mcp/manager.js'
import { emptyPhysarumShadowStats, type PhysarumShadowStats } from '../../repo/physarum-shadow-stats.js'
import { STAR_DOMAINS } from '../../agent/star-domain.js'
import type { CockpitSnapshot, Panel, PanelStatus } from './types.js'

export interface CockpitSnapshotSources {
  agent: AgentLoop
  session: SessionContext
  model?: string
  cacheHitRate?: number
  cost?: number
  mcpManager?: McpManager | null
  claimCounts?: import('../../context/promotion.js').ClaimStatusCounts
  reasoningEffort?: string
}

/**
 * Human-readable star-domain label for the cockpit Model panel.
 *  - object    → pinned domain name (e.g. 破军)
 *  - undefined → Auto with the keyword fallback in parens (Auto(天枢))
 *  - null      → STAR_SOUL kill switch (no persona at all)
 */
function describeStarDomain(domain: import('../../agent/star-domain.js').ActiveStarDomain | null | undefined): string {
  if (domain) return domain.name
  if (domain === null) return '关闭(环境)'
  const fallback = STAR_DOMAINS.tianshu?.name ?? '天枢'
  return `Auto(${fallback})`
}

function computePanelStatuses(snapshot: Omit<CockpitSnapshot, 'panelStatuses'>): Record<Panel, PanelStatus> {
  const safety: PanelStatus = snapshot.safety.riskLevel === 'high' || snapshot.safety.doomLoopLevel === 'blocked'
    ? 'error'
    : snapshot.safety.riskLevel === 'medium' || snapshot.safety.doomLoopLevel === 'warn'
      ? 'warn'
      : 'ok'

  const verify: PanelStatus = snapshot.verification.deliveryStatus === 'failed' || snapshot.verification.deliveryStatus === 'blocked'
    ? 'error'
    : snapshot.verification.deliveryStatus === 'unverified' && snapshot.verification.filesModified > 0
      ? 'warn'
      : 'ok'

  const context: PanelStatus = snapshot.context
    ? snapshot.context.brokenRounds > 0
      ? 'error'
      : snapshot.context.compactionState === 'critical'
        ? 'error'
        : snapshot.context.compactionState === 'warning'
          ? 'warn'
          : 'ok'
    : 'idle'

  const model: PanelStatus = 'ok'
  const trace: PanelStatus = snapshot.trace.events.some(e => e.status === 'failed')
    ? 'error'
    : 'ok'
  const summary: PanelStatus = safety === 'error' || verify === 'error'
    ? 'error'
    : safety === 'warn' || verify === 'warn'
      ? 'warn'
      : 'ok'

  const mcp: PanelStatus = snapshot.mcp.servers.some(s => s.status === 'error')
    ? 'error'
    : snapshot.mcp.servers.some(s => s.status === 'connecting')
      ? 'warn'
      : 'ok'

  return { summary, trace, verify, context, safety, model, mcp }
}

export function buildCockpitSnapshot(sources: CockpitSnapshotSources): CockpitSnapshot {
  const { agent, session, claimCounts, reasoningEffort } = sources
  const model = sources.model ?? 'unknown'
  const cacheHitRate = sources.cacheHitRate ?? session.getCacheHitRate()
  const cost = sources.cost ?? 0
  const mcpManager = sources.mcpManager ?? null
  const agentWithCache = agent as AgentLoop & {
    getPrewarmStats?: () => { hits: number; misses: number; hitRate: number }
    getPhysarumShadowStats?: () => PhysarumShadowStats
    getCacheDiagnostic?: () => string | null
  }
  const prewarmStats = agentWithCache.getPrewarmStats?.() ?? { hits: 0, misses: 0, hitRate: 0 }
  const physarumShadowStats = agentWithCache.getPhysarumShadowStats?.() ?? emptyPhysarumShadowStats()
  const cacheDiagnostic = agentWithCache.getCacheDiagnostic?.() ?? null

  const traceStore = agent.getTraceStore()
  const evidence = agent.getEvidenceState()
  const doomLevel = agent.getDoomLoopLevel()
  const usage = session.getTotalUsage()
  const risk = agent.getLatestRisk()
  const contextReport = agent.getContextLayerReport()
  const mcpStates = mcpManager?.getStates() ?? []
  const deliveryGate = buildDeliveryGate(evidence)

  const snapshot: Omit<CockpitSnapshot, 'panelStatuses'> = {
    intent: null,
    blockingReason: deliveryGate.blockingReason ?? null,
    nextAction: deliveryGate.nextAction ?? null,
    safety: {
      doomLoopLevel: doomLevel,
      riskLevel: risk.level,
      riskReasons: risk.reasons,
      suggestedAction: risk.suggestedAction,
      recentFingerprints: new Set(traceStore.toolFingerprints).size,
    },
    verification: {
      filesRead: evidence.filesRead.size,
      filesModified: evidence.filesModified.size,
      runs: evidence.verifications.map(v => ({
        tool: v.command,
        status: v.status,
        summary: `${v.passed}✓ ${v.failed}✗ ${v.skipped}skip`,
      })),
      deliveryStatus: evidence.deliveryStatus,
      impactedFiles: evidence.impactedFiles.size,
      impactedTests: evidence.impactedTests.size,
    },
    trace: {
      events: traceStore.events.map(e => ({
        id: e.id,
        turn: e.turn,
        kind: e.kind,
        name: e.name,
        status: e.status,
        durationMs: e.durationMs,
        summary: e.summary,
      })),
      totalEvents: traceStore.events.length,
    },
    context: session.getContextLedger()
      ? {
          estimatedTokens: session.getContextLedger()!.tokenBudget.estimatedTokens,
          maxTokens: session.getContextLedger()!.tokenBudget.maxTokens,
          rounds: session.getContextLedger()!.rounds.length,
          compactionState: session.getContextLedger()!.tokenBudget.compactionState,
          brokenRounds: session.getContextLedger()!.apiInvariantStatus.brokenRounds,
          layers: contextReport.layers.map(l => ({
            id: l.id,
            label: l.label,
            stability: l.stability,
            channel: l.channel,
            fingerprint: l.fingerprint,
            digest: l.digest,
            tokenEstimate: l.tokenEstimate,
          })),
          claimCounts: claimCounts ?? { active: 0, stale: 0, conflicted: 0, durable: 0, durableCandidate: 0, quarantined: 0, recallBlocked: 0 },
        }
      : null,
    model: {
      name: model,
      cacheHitRate,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      cost,
      perTurnHitRate: session.getLatestTurnHitRate(),
      recentTurnHitRate: session.getRecentTurnHitRate(3),
      prewarmHits: prewarmStats.hits,
      prewarmMisses: prewarmStats.misses,
      prewarmHitRate: prewarmStats.hitRate,
      physarumShadow: physarumShadowStats,
      cacheDiagnostic,
      reasoningEffort: agent.getReasoningEffort() || reasoningEffort || 'medium',
      starDomain: describeStarDomain(agent.getSessionDomain()),
    },
    mcp: {
      servers: mcpStates.map(s => ({
        serverId: s.serverId,
        status: s.status,
        toolCount: s.toolCount,
        lastErrorClass: s.lastErrorClass,
      })),
      totalTools: mcpManager?.getAllTools().length ?? 0,
      connectedServers: mcpStates.filter(s => s.status === 'connected').length,
    },
  }

  return {
    ...snapshot,
    panelStatuses: computePanelStatuses(snapshot),
  }
}
