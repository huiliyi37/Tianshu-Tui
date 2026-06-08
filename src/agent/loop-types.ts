import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import type { StreamRule } from './turn-stream.js'
import type { PromptEngine } from '../prompt/engine.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { CompactionConfig } from '../compact/constants.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { HookRegistry } from '../hooks/registry.js'
import type { RuntimeHookPipeline } from './runtime-hooks.js'
import type { ModelCapabilityCard } from '../model/capability.js'
import type { PlanModeState } from './plan-mode.js'
import type { PermissionConfig } from './permissions.js'
import type { ApprovalResult } from './approval-edit.js'
import type { ResourceSensorOptions } from './resource-sensor.js'
import type { ProviderHealthTracker } from './provider-health.js'
import type { PlaybookStore } from './playbook-store.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import type { IntentRetrievalRouterConfigInput } from './intent-retrieval-router.js'
import type { IntentPreview, IntentPreviewAction } from './intent-preview.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'

export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'

export interface AgentConfig {
  client: StreamClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  providerProfile?: ProviderProfile
  /** Primary model's StreamClient — reused for LLM compaction via Forked Agent pattern. */
  primaryClient?: StreamClient
  approvalMode?: ApprovalMode
  sessionId?: string
  /** Review-router re-entrancy depth. Worker contexts spawned by review routing use depth > 0. */
  reviewDepth?: number
  /** Optional session registry for cross-session event communication. */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  transcriptPath?: string
  getSessionMemoryState?: () => import('../context/types.js').LedgerSessionMemoryState | undefined
  hooks?: HookRegistry
  runtimeHooks?: RuntimeHookPipeline
  fileHistory?: import('./file-history.js').FileHistory
  modelCards?: ModelCapabilityCard[]
  /** Shadow-only model routing telemetry cards. Does not enable model switching. */
  modelRoutingShadowModelCards?: ModelCapabilityCard[]
  /** Record routing recommendations as append-only telemetry without changing model selection. Default: enabled when a MeridianDb is available. */
  modelRoutingShadowEnabled?: boolean
  onModelSwitch?: (newModel: string) => void
  getCurrentModel?: () => string
  autoReasoning?: boolean
  reasoningEffort?: import('./auto-reasoning.js').ReasoningEffort
  reasoningFloor?: import('./auto-reasoning.js').ReasoningEffort
  /** T2-02 Track A2: Enable bandit-controlled effort delta. Default false.
   *  When false, bandit runs in shadow mode only (telemetry, no behavior change).
   *  When true, bandit recommendations may adjust reasoning effort after the
   *  consistency-promotion gate passes. */
  effortBanditEnabled?: boolean
  /** Turn-level thinking: disable thinking on tool execution turns (GLM turn-level thinking).
   *  Reduces reasoning_content accumulation and prevents context window stalls. */
  turnLevelThinking?: boolean
  lspEnabled?: boolean
  /** Optional LSP manager — notified on file changes for goto-def / find-refs accuracy. */
  lspManager?: import('../lsp/manager.js').LspManager
  permissions?: PermissionConfig
  contextClaimStore?: ContextClaimStore
  /** Optional provider health tracker for Physarum-style routing.
   *  Degradation ratio affects sensorium stability dimension. */
  providerHealth?: ProviderHealthTracker
  playbookStore?: PlaybookStore
  /** Optional resource sensor injection for reliability tests and custom deployments. */
  resourceSensorOptions?: ResourceSensorOptions
  /** Disable fs watcher in tests or constrained environments. Enabled by default. */
  fsWatcherEnabled?: boolean
  /** Optional TaskLedger for B1 ownership tracking — records file_read/file_write/tool_exec events. */
  taskLedger?: import('./task-ledger.js').TaskLedger
  /** Explicit opt-in for Songline substrate post-session pheromone/cycle relay. Disabled by default. */
  songlineEnabled?: boolean
  /** Explicit opt-in for HEARTH anchor invariant observation (postTurn, diagnostic only). Disabled by default. */
  hearthObserveEnabled?: boolean
  /** Explicit opt-in for anti-anchoring harness hooks. Disabled by default. */
  antiAnchoring?: AntiAnchoringConfig
  /** Optional current-turn intent retrieval route guidance. Disabled by default. */
  intentRetrievalRouter?: IntentRetrievalRouterConfigInput
  /** Optional OwnershipLedger for real-time file ownership — updated on every file_write. */
  ownershipLedger?: import('./ownership-ledger.js').OwnershipLedger
  /** Optional Meridian code graph indexer for structural context. */
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
  /** Plan Mode state — when 'planning', write tools are blocked in tool-pipeline. */
  planModeState?: PlanModeState
  /** Optional stream rules — abort and inject reminders when model output matches patterns.
   *  Each rule has a regex `pattern` and an `inject` message appended as a user reminder. */
  streamRules?: StreamRule[]
  /** V3 Component B: per-domain knowledge persistence for worker lesson precipitation. */
  domainKnowledgeStore?: DomainKnowledgeStore
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean) => void
  onError: (error: Error) => void
  onAbort: () => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
  onCheckpoint?: (hash: string) => void
  onPhaseChange?: (phase: string, detail?: { tool?: string; reason?: string; suggestion?: string }) => void
  onIntentPreview?: (intent: IntentPreview) => Promise<IntentPreviewAction>
  /** Called to drain any pending steer guidance for injection into tool results */
  onSteerDrain?: () => string | null
}
