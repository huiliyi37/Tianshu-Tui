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
import type { HookEvent, HookResult } from '../hooks/user-hooks-runner.js'
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
import type { DelegationActivity } from '../tools/types.js'

export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'

export interface AgentConfig {
  client: StreamClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  maxTurns: number
  /**
   * Max auto-continue iterations per run when a no-tool turn shows action intent
   * or an open task contract (phantom tool-call recovery). 0 disables. Default 0
   * when unset (caller opts in via config.agent.maxAutoContinue).
   */
  maxAutoContinue?: number
  contextWindow: number
  compact: CompactionConfig
  providerProfile?: ProviderProfile
  /** Provider registry key (e.g. 'deepseek') — used as ProviderHealthTracker id. */
  providerName?: string
  /** Primary model's StreamClient — reused for LLM compaction via Forked Agent pattern. */
  primaryClient?: StreamClient
  approvalMode?: ApprovalMode
  sessionId?: string
  /** Review-router re-entrancy depth. Worker contexts spawned by review routing use depth > 0. */
  reviewDepth?: number
  /** B3: delegation nesting depth of THIS agent (primary=0, worker=1, grand-worker=2).
   *  Propagated into delegate tool calls so the coordinator can cap recursion. */
  delegationDepth?: number
  /** Optional session registry for cross-session event communication. */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  transcriptPath?: string
  getSessionMemoryState?: () => import('../context/types.js').LedgerSessionMemoryState | undefined
  hooks?: HookRegistry
  runtimeHooks?: RuntimeHookPipeline
  /** I4: emit user hook results to the desktop event stream. */
  emitHookResult?: (results: HookResult[], meta: { event: HookEvent; turn?: number; toolName?: string; error?: string }) => void
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
  /**
   * 2D（默认关）：客户端重试耗尽后的 agent 层有界重连。仅当本轮 streamError 被
   * classifyApiError 判为 shouldReconnect、且未 abort 时，丢弃本轮 partial blocks 与
   * streamedText（守护 prefix cache 不被污染），用**相同 request** 重新发起流。
   * 默认禁用——保守特性，需显式开启。 */
  agentReconnect?: {
    enabled: boolean
    /** 最大重连次数（不含首次）。默认 1。 */
    maxAttempts?: number
    /** 每次重连前的退避（ms，可被 abort 打断）。默认 500。 */
    backoffMs?: number
  }
  lspEnabled?: boolean
  /** Optional LSP manager — notified on file changes for goto-def / find-refs accuracy.
   *  Use `getLspManager` for late-binding (LSP initialized asynchronously after AgentLoop). */
  lspManager?: import('../lsp/manager.js').LspManager
  /** T4: late-bound LSP manager getter. Preferred over static `lspManager` for T9 path
   *  where LSP initializes asynchronously after AgentLoop construction. */
  getLspManager?: () => import('../lsp/manager.js').LspManager | null
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
  /** Track 3: 权威交付门禁（v2 GREEN/YELLOW/RED）。接入后 evidence badge 与
   *  收敛检测以 v2 状态为准；缺省回退 v1（EvidenceState 推导）。 */
  deliveryGateV2?: (currentDirtyFiles?: string[]) => import('./delivery-gate-v2.js').DeliveryGateResult
  /** Explicit opt-in for Songline substrate post-session pheromone/cycle relay. Disabled by default. */
  songlineEnabled?: boolean
  /** Explicit opt-in for HEARTH anchor invariant observation (postTurn, diagnostic only). Disabled by default. */
  hearthObserveEnabled?: boolean
  /** Enable cross-session knowledge loading (memory block, playbook events, companion presence).
   *  Default true — injects distilled project knowledge into prompt.
   *  Env RIVET_NO_CROSS_SESSION=1 overrides as force-off. */
  crossSessionEnabled?: boolean
  /** Explicit opt-in for anti-anchoring harness hooks. Disabled by default. */
  antiAnchoring?: AntiAnchoringConfig
  /** Disable theta (tsc --noEmit) checks. Workers use this to skip redundant typechecking. Default: false (enabled). */
  thetaCheckDisabled?: boolean
  /** Optional current-turn intent retrieval route guidance. Disabled by default. */
  intentRetrievalRouter?: IntentRetrievalRouterConfigInput
  /** Optional OwnershipLedger for real-time file ownership — updated on every file_write. */
  ownershipLedger?: import('./ownership-ledger.js').OwnershipLedger
  /** VSW: session-scoped snapshot manager. When present, run_tests asks it for a
   *  verification snapshot plan; §6 policy decides snapshot-vs-in-place, so the
   *  default (single clean session) stays in-place and behavior is unchanged. */
  verificationSnapshotManager?: import('./verification-snapshot-manager.js').VerificationSnapshotManager
  /** Optional Meridian code graph indexer for structural context. */
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
  /** Plan Mode state — when 'planning', write tools are blocked in tool-pipeline. */
  planModeState?: PlanModeState
  /** Optional stream rules — abort and inject reminders when model output matches patterns.
   *  Each rule has a regex `pattern` and an `inject` message appended as a user reminder. */
  streamRules?: StreamRule[]
  /** V3 Component B: per-domain knowledge persistence for worker lesson precipitation. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Lazy getter for DelegationCoordinator — wired by main.tsx for auto-delegation hooks. */
  coordinatorRef?: () => import('./coordinator.js').DelegationCoordinator | null
  /** All configured providers, keyed by name. Used by goal-criteria's buildCheapClient
   *  to construct a dedicated cheap StreamClient (and by the fallback chain). */
  allProviders?: Record<string, import('../config/schema.js').ProviderConfig>
  /** Explicit opt-in for auto-delegation. Default false — workers cost API budget. */
  autoDelegateEnabled?: boolean
  /** Goal completion judge config (gates /goal & --goal self-declared completion). */
  goalJudge?: {
    /** Default true. When false, the orchestrator accepts the GOAL ACHIEVED marker directly. */
    enabled?: boolean
    /** Max judge runs before accepting unverified (anti reject-loop). Default 3. */
    maxRuns?: number
    /** Phase 2: allow the judge UI/API/DB browser verification. Default false. */
    browser?: boolean
  }
  /** 主控工具门控配置。决定哪些 EXTENDED 工具从主控摘除（委派给 worker）。
   *  updateTools() 复用此状态重新过滤，避免 MCP/LSP 异步注册后把门控整个还原。
   *  缺省 undefined → 不门控（全量）。 */
  toolGating?: {
    enabled: boolean
    coreOverride?: readonly string[]
    extraCore?: readonly string[]
    domainTier?: readonly string[]
  }
  /** 当前 provider 的前缀缓存策略 — 逃生口 /tools enable 用它量化挂载的缓存代价。 */
  prefixCacheStrategy?: 'deepseek-native' | 'anthropic-cache-control' | 'none'
}

/**
 * A structured "course-correction" signal (R4). Emitted only at moments that are
 * meaningful to a watching human: the agent was stuck / convergence stalled, the
 * star-domain harness offered a different framing, and the agent is about to act
 * on it. Internal bookkeeping (heartbeat / sensorium curves / cache diagnostics)
 * deliberately does NOT emit these — selective visibility.
 */
export interface DecisionShift {
  /** Which mechanism produced the nudge. */
  source: 'kick' | 'convergence' | 'radio'
  /** Star-domain persona / domain label (e.g. '天璇'), when applicable. */
  domain?: string
  /** Human-readable reason the agent was stuck / why a shift is warranted. */
  reason: string
  /** Alternative methods / frameworks offered to break the impasse. */
  methods: string[]
  /** Visual weight hint for the UI. Defaults to 'info'. */
  severity?: 'info' | 'warn'
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean) => void
  onError: (error: Error) => void
  onAbort: (reason?: string) => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
  onCheckpoint?: (hash: string) => void
  onPhaseChange?: (phase: string, detail?: { tool?: string; reason?: string; suggestion?: string }) => void
  /** R4 — structured course-correction signal surfaced to the desktop conversation. */
  onDecisionShift?: (shift: DecisionShift) => void
  onIntentPreview?: (intent: IntentPreview) => Promise<IntentPreviewAction>
  /** Called to drain any pending steer guidance for injection into tool results */
  onSteerDrain?: () => string | null
  /** T4 — structured per-worker delegation status/progress (subagent panel). */
  onDelegationActivity?: (activity: DelegationActivity) => void
}
