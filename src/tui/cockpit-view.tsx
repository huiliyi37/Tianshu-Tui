import { useMemo, type RefObject } from 'react'
import { Box, Text } from 'ink'
import { getTheme } from './theme.js'
import { CockpitRail, TracePanel, VerificationPanel, ContextPanel, SafetyPanel, ModelPanel, McpPanel } from './cockpit/index.js'
import { buildCockpitSnapshot } from './cockpit/state.js'
import type { Panel } from './cockpit/types.js'
import type { AgentLoop } from '../agent/loop.js'
import type { SessionContext } from '../agent/context.js'
import type { McpManager } from '../mcp/manager.js'

export interface CockpitViewProps {
  panel: Panel
  agent: AgentLoop
  session: SessionContext
  model: string
  cacheHitRate: number
  cost: number
  mcpManager: McpManager | null
  claimStoreRef: RefObject<import('../context/claim-store.js').ContextClaimStore | null>
}

export function CockpitView({ panel, agent, session, model, cacheHitRate, cost, mcpManager, claimStoreRef }: CockpitViewProps) {
  const theme = getTheme()
  const snap = useMemo(
    () => buildCockpitSnapshot({ agent, session, model, cacheHitRate, cost, mcpManager, claimCounts: claimStoreRef.current?.getStatusCounts() }),
    [agent, session, model, cacheHitRate, cost, mcpManager, claimStoreRef],
  )
  const compactEvents = useMemo(() => session.getCompactEvents(), [session])

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={theme.dim}>
      <Text color={theme.primary} bold>cockpit</Text>
      <CockpitRail activePanel={panel} panelStatuses={snap.panelStatuses} onSelect={() => {}} />
      {panel === 'trace' && <TracePanel events={snap.trace.events} />}
      {panel === 'verify' && <VerificationPanel filesRead={snap.verification.filesRead} filesModified={snap.verification.filesModified} verifications={snap.verification.runs} deliveryStatus={snap.verification.deliveryStatus} impactedFiles={snap.verification.impactedFiles} impactedTests={snap.verification.impactedTests} />}
      {panel === 'context' && snap.context && <ContextPanel estimatedTokens={snap.context.estimatedTokens} maxTokens={snap.context.maxTokens} rounds={snap.context.rounds} compactionState={snap.context.compactionState} brokenRounds={snap.context.brokenRounds} compactEvents={compactEvents.map(e => ({ turn: e.turn, tier: e.tier, beforeTokens: e.beforeTokens, afterTokens: e.afterTokens }))} layers={snap.context.layers} />}
      {panel === 'safety' && <SafetyPanel doomLoopLevel={snap.safety.doomLoopLevel} riskLevel={snap.safety.riskLevel} riskReasons={snap.safety.riskReasons} suggestedAction={snap.safety.suggestedAction} recentFingerprints={snap.safety.recentFingerprints} />}
      {panel === 'model' && <ModelPanel model={snap.model.name} cacheHitRate={snap.model.cacheHitRate} inputTokens={snap.model.inputTokens} outputTokens={snap.model.outputTokens} cacheReadTokens={snap.model.cacheReadTokens} cacheWriteTokens={snap.model.cacheWriteTokens} cost={snap.model.cost} routingReason={snap.model.routingReason ?? undefined} perTurnHitRate={snap.model.perTurnHitRate} recentTurnHitRate={snap.model.recentTurnHitRate} prewarmHits={snap.model.prewarmHits} prewarmMisses={snap.model.prewarmMisses} prewarmHitRate={snap.model.prewarmHitRate} physarumShadow={snap.model.physarumShadow} cacheDiagnostic={snap.model.cacheDiagnostic} reasoningEffort={snap.model.reasoningEffort} />}
      {panel === 'mcp' && <McpPanel servers={snap.mcp.servers} totalTools={snap.mcp.totalTools} connectedServers={snap.mcp.connectedServers} />}
    </Box>
  )
}
