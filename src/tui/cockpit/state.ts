import type { AgentLoop } from '../../agent/loop.js'
import type { SessionContext } from '../../agent/context.js'
import { buildDeliveryGate } from '../../agent/delivery-gate.js'
import type { McpManager } from '../../mcp/manager.js'
import { emptyPhysarumShadowStats, type PhysarumShadowStats } from '../../repo/physarum-shadow-stats.js'
import { STAR_DOMAINS } from '../../agent/star-domain.js'
import { detectCriticalMoments, getExpertBenchStats, type StrongExpertRouter } from '../../agent/strong-expert.js'
import {
  loadStrongExpertRecords,
  recommendStrongExpertForMoment,
  summarizeStrongExpertLearning,
  type StrongExpertRoutingStore,
} from '../../agent/strong-expert-learning.js'
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
  /** status 通道最近条目（main.ts statusSink 环形缓冲注入,dark cockpit） */
  advisoryStatusNotices?: string[]
}

/**
 * Human-readable star-domain label for the cockpit Model panel.
 *  - object    → pinned domain name (e.g. 破军)
 *  - undefined → Auto (keyword routing, fallback 天枢) shown as Auto(天枢)
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

  // 有 key 被静音 = 提醒系统在做降噪干预,值得一眼注意
  const advisory: PanelStatus = snapshot.advisory.silenced.length > 0 ? 'warn' : 'ok'

  return { summary, trace, verify, context, safety, model, mcp, advisory }
}

/** advisory 面板 per-key Top 行数上限 */
const ADVISORY_PANEL_MAX_KEYS = 8

function buildAdvisorySection(agent: AgentLoop, statusNotices: string[]): CockpitSnapshot['advisory'] {
  // 部分上下文（测试 mock / server / desktop）只传部分 AgentLoop——面板降级为零值
  const ga = agent.guardianActivity as AgentLoop['guardianActivity'] | undefined
  const readback = agent.advisoryReadback as AgentLoop['advisoryReadback'] | undefined
  const bus = agent.advisoryBus as AgentLoop['advisoryBus'] | undefined
  const keys = readback
    ? [...readback.getStats()]
        .filter(([, s]) => s.delivered > 0 || s.shadowHeld > 0)
        .sort((a, b) => b[1].delivered - a[1].delivered)
        .slice(0, ADVISORY_PANEL_MAX_KEYS)
        .map(([key, s]) => ({
          key,
          delivered: s.delivered,
          adopted: s.adopted,
          ignored: s.ignored,
          ignoredStreak: s.ignoredStreak,
          adoptionRate: readback.getAdoptionRate(key),
          lift: readback.getMatureLift(key),
        }))
    : []
  return {
    rendered: ga?.advisoriesRendered ?? 0,
    dropped: ga?.advisoriesDropped ?? 0,
    adopted: ga?.advisoriesAdopted ?? 0,
    ignored: ga?.advisoriesIgnored ?? 0,
    heldOut: ga?.advisoriesHeldOut ?? 0,
    silenced: bus?.getSilencedKeys() ?? [],
    pendingWatch: bus?.getPendingWatchCount() ?? 0,
    keys,
    statusNotices,
  }
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
  // 部分上下文（mock/server）可能没有 p3——面板降级为 null（不显示投机行）
  const speculationStats = (agent as Partial<AgentLoop>).p3?.queue.statsBySource() ?? null
  // Zen 镜像：测试 mock / worker 会话无 zenController 时降级为 full/unarmed。
  const zenController = (agent as Partial<AgentLoop>).zenController
  const zenStats = zenController?.snapshot().zenStats

  const traceStore = agent.getTraceStore()
  const evidence = agent.getEvidenceState()
  const doomLevel = agent.getDoomLoopLevel()
  const usage = session.getTotalUsage()
  const risk = agent.getLatestRisk()
  const contextReport = agent.getContextLayerReport()
  const mcpStates = mcpManager?.getStates() ?? []
  const deliveryGate = buildDeliveryGate(evidence)
  const contextLedger = session.getContextLedger()
  // P2e shadow→gate：从 MeridianDb 读 SEA 路由账本；特性旗标默认关（只 shadow）。
  const meridianDb = (agent as Partial<AgentLoop>).config?.meridianIndexer?.getDb?.()
  const routingStore = meridianDb as unknown as StrongExpertRoutingStore | undefined
  const learningState = summarizeStrongExpertLearning(loadStrongExpertRecords(routingStore))
  const learningRouter: StrongExpertRouter = {
    recommend: (kind, rule) => recommendStrongExpertForMoment(
      learningState,
      kind,
      rule,
      process.env.RIVET_STRONG_EXPERT_ROUTING === '1',
    ),
  }
  const expertSignals = detectCriticalMoments({
    doomLoopLevel: doomLevel,
    contextPressureRatio: contextLedger && contextLedger.tokenBudget.maxTokens > 0
      ? contextLedger.tokenBudget.estimatedTokens / contextLedger.tokenBudget.maxTokens
      : 0,
    convergencePlateau: ((agent as Partial<AgentLoop>).latestConvergenceResult?.level ?? 0) >= 2,
  }, learningRouter).map(m => ({ kind: m.kind, suggestedExpert: m.suggestedExpert, auto: m.auto }))
  const expertBench = getExpertBenchStats((agent as Partial<AgentLoop>).config?.sessionId)

  const snapshot: Omit<CockpitSnapshot, 'panelStatuses'> = {
    intent: null,
    blockingReason: deliveryGate.blockingReason ?? null,
    nextAction: deliveryGate.nextAction ?? null,
    expertSignals,
    expertBench,
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
    zen: {
      phase: zenController?.currentPhase ?? 'full',
      armed: zenStats?.armed ?? false,
      ...(zenController?.lastPromoteReason
        ? { promoteReason: zenController.lastPromoteReason }
        : {}),
      zenTurns: zenStats?.zenTurns ?? 0,
      faceMode: zenController?.resolvedConfig.faceMode ?? 'minimal',
      face: zenController ? [...zenController.face] : [],
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
      speculation: speculationStats,
      cacheDiagnostic,
      reasoningEffort: agent.getReasoningEffort() || reasoningEffort || 'medium',
      starDomain: describeStarDomain(agent.getSessionDomain()),
      // W-stats：首字/输出速度均值（loop 累计；样本 0 时 undefined → UI 空组消失）
      avgTtftMs: agent.ttftSamples > 0 ? Math.round(agent.ttftTotalMs / agent.ttftSamples) : undefined,
      avgTps: agent.decodeMsSum > 0 ? Math.round((agent.decodeTokensSum / (agent.decodeMsSum / 1000)) * 10) / 10 : undefined,
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
    advisory: buildAdvisorySection(agent, sources.advisoryStatusNotices ?? []),
  }

  return {
    ...snapshot,
    panelStatuses: computePanelStatuses(snapshot),
  }
}
