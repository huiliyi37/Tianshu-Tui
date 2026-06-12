/**
 * bootstrap.ts — 共享初始化层，被 main.tsx (Ink) 和 main-ansi.ts (T9 ANSI) 共用。
 *
 * 提取自 main.tsx 的 Root 组件，消除 React 依赖，提供纯异步函数。
 * 目标：零回归切换 main.tsx，同时让 main-ansi.ts 成为完整替代入口。
 *
 * 架构：
 *   bootstrapInteractiveSession() → BootstrapContext
 *   ├── main.tsx 在 Root 组件内调用（React hooks 包装）
 *   └── main-ansi.ts 直接 await 调用
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { spawnSync, spawn } from 'child_process'

import type { Config, ProviderConfig } from './config/schema.js'
import type { AuthProvider } from './auth/types.js'
import type { BaselineSnapshot } from './agent/worktree-baseline.js'
import type { ModelCapabilityCard } from './model/capability.js'

import { loadConfig as loadLayeredConfig } from './config/manager.js'
import { AgentLoop } from './agent/loop.js'
import { createAgentConfig, createMainAgentConfigInput } from './agent/create-agent-config.js'
import { SessionContext } from './agent/context.js'
import { SessionPersist, evictOldSessions } from './agent/session-persist.js'
import { FileHistory } from './agent/file-history.js'
import { PromptEngine } from './prompt/engine.js'
import { createDefaultToolRegistry } from './tools/default-registry.js'
import { createDelegateTaskTool } from './tools/delegate-task.js'
import { createUndoTool } from './tools/undo.js'
import { createDelegateBatchTool } from './tools/delegate-batch.js'
import { createTeamOrchestrateTool } from './tools/team-orchestrate.js'
import { createRecallCapsuleTool } from './tools/recall-capsule.js'
import { createDeliverTaskTool } from './agent/deliver-task.js'
import { createTaskLedger } from './agent/task-ledger.js'
import { createOwnershipLedger } from './agent/ownership-ledger.js'
import { createVerificationAttribution } from './agent/verification-attribution.js'
import { createDeliveryGateV2 } from './agent/delivery-gate-v2.js'
import { createWorktreeBaseline } from './agent/worktree-baseline.js'
import { createProviderClient, resolveApiKey } from './api/factory.js'
import { createAuthProvider } from './auth/registry.js'
import { resolveCapabilities } from './api/provider.js'
import { DelegationCoordinator } from './agent/coordinator.js'
import { ProviderHealthTracker } from './agent/provider-health.js'
import { effectiveBanditMode, resolveBanditPromotion } from './agent/bandit-promotion.js'
import { DomainKnowledgeStore } from './agent/domain-knowledge-store.js'
import { profileRegistry } from './agent/profile-registry.js'
import { starDomainRegistry } from './agent/star-domain-registry.js'
import type { WorkerRuntimeFactory } from './agent/coordinator.js'
import { mapWorkOrderKindToCapabilityTask } from './agent/work-order.js'
import { PlaybookStore } from './agent/playbook-store.js'
import { ASK_USER_QUESTION_TOOL } from './tools/ask-user-question.js'
import { createRepoGraphTool } from './tools/repo-graph.js'
import { createRecallTool } from './tools/recall.js'
import { createRememberTool } from './tools/remember.js'
import { MeridianIndexer } from './repo/meridian-indexer.js'
import { loadProjectRules } from './context/rules-loader.js'
import { killAllSync } from './tools/process-tracker.js'
import { persistFileHistory } from './agent/file-history-persist.js'
import { cleanupOrphanedTmpFiles } from './fs-atomic.js'
import { cleanupOldArtifactSessions } from './artifact/store.js'
import { createLspManager } from './lsp/manager.js'
import { createGotoDefinitionTool, createFindReferencesTool } from './lsp/tools.js'
import { createCoordinatorReviewDeps } from './agent/review-coordinator-deps.js'
import { persistTeamWaveTelemetry, type TeamWaveTelemetry } from './agent/team-wave-telemetry.js'
import { buildTeamSchedulerRewardEvent, persistTeamSchedulerReward, persistTeamSchedulerShadow, type TeamSchedulerShadowEvent } from './agent/team-scheduler-shadow.js'
import { persistGatedInfluenceAudit, type GatedInfluenceAuditEvent } from './agent/gated-influence-audit.js'
import { computeTeamWaveReward, deriveTeamWaveRewardInput } from './agent/team-reward.js'
import { teamSchedulerArmForParallelism } from './agent/team-scheduler-bandit.js'
import { recordTeamWaveRewardClosure } from './agent/reward-loop.js'
import { debugLog } from './utils/debug.js'

// ── Types ──────────────────────────────────────────────────────

/** 运行时可变引用 — 替代 main.tsx 中的 module-level _xxxRef 全局变量 */
export interface RuntimeRefs {
  coordinator: DelegationCoordinator | null
  fileHistory: FileHistory | null
  claimStore: import('./context/claim-store.js').ContextClaimStore | null
  sessionId: string | null
  sessionRegistry: import('./agent/session-registry.js').SessionRegistry | null
  taskLedger: import('./agent/task-ledger.js').TaskLedger | null
  ownershipLedger: import('./agent/ownership-ledger.js').OwnershipLedger | null
  /** Track 3: 权威交付门禁（v2）— badge 与收敛检测共用。 */
  deliveryGate: import('./agent/delivery-gate-v2.js').DeliveryGateV2 | null
  meridianIndexer: MeridianIndexer | null
  mcpManager: any | null
  lspManager: ReturnType<typeof createLspManager> | null
  /** T5: bandit promotion state for /status observability. */
  banditState: import('./server/routes.js').BanditStatusEntry[] | null
}

/** bootstrapInteractiveSession 的聚合返回值 */
export interface BootstrapContext {
  config: Config
  provider: ProviderConfig
  apiKey: string
  auth: AuthProvider | undefined
  sessionId: string
  session: SessionContext
  persist: SessionPersist
  claimStore: import('./context/claim-store.js').ContextClaimStore
  fileHistory: FileHistory
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  agent: AgentLoop
  refs: RuntimeRefs
  domainKnowledgeStore: DomainKnowledgeStore
  meridianIndexer: MeridianIndexer
  cwd: string
  shutdown: () => void
  heartbeatInterval: ReturnType<typeof setInterval>
}

// ── HTTP Proxy ─────────────────────────────────────────────────

let _proxySetup = false

export function setupHttpProxy(): void {
  if (_proxySetup) return
  _proxySetup = true
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (proxyUrl) {
    setGlobalDispatcher(new EnvHttpProxyAgent())
  }
}

// ── Config ─────────────────────────────────────────────────────

function approvalOverlayFromArgs(args: string[]): Record<string, unknown> | undefined {
  if (args.includes('--dangerously-skip-permissions') || args.includes('--dangerously-skip-approvals')) {
    return { agent: { approval: 'dangerously-skip-permissions' } }
  }
  const modeIndex = args.indexOf('--approval-mode')
  if (modeIndex >= 0) {
    const mode = args[modeIndex + 1]
    if (!mode) {
      console.error('--approval-mode requires a value')
      process.exit(2)
    }
    return { agent: { approval: mode } }
  }
  return undefined
}

export function loadRivetConfig(cwd?: string, args: string[] = process.argv.slice(2)): Config {
  return loadLayeredConfig({ cwd, sessionOverlay: approvalOverlayFromArgs(args) })
}

// ── Provider + Auth ────────────────────────────────────────────

export function resolveProviderAndAuth(
  config: Config,
  providerName?: string,
): { provider: ProviderConfig; apiKey: string; auth: AuthProvider | undefined } {
  const name = providerName ?? config.provider.default
  const provider = config.provider.providers[name]
  if (!provider) {
    console.error(`Provider "${name}" not configured. Available: ${Object.keys(config.provider.providers).join(', ')}`)
    process.exit(1)
  }

  if (provider.auth?.type === 'oauth') {
    const auth = createAuthProvider(provider.auth, process.env, provider.apiKey)
    return { provider, apiKey: '', auth }
  }

  const apiKey = resolveApiKey(provider)
  return { provider, apiKey, auth: undefined }
}

// ── Git Baseline ───────────────────────────────────────────────

export function captureGitBaseline(cwd: string): BaselineSnapshot {
  try {
    const branch = spawnSync('git', ['-c', 'core.quotePath=false', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    const head = spawnSync('git', ['-c', 'core.quotePath=false', 'rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    const dirty = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    const untracked = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    return {
      branch,
      head,
      preExistingDirty: dirty ? dirty.split('\n') : [],
      preExistingUntracked: untracked ? untracked.split('\n') : [],
      capturedAt: Date.now(),
    }
  } catch {
    return { branch: '', head: '', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }
  }
}

// ── Session ID ─────────────────────────────────────────────────

let _cachedSessionId: string | null = null

export function getOrCreateSessionId(): string {
  if (_cachedSessionId) return _cachedSessionId
  const dir = join(homedir(), '.rivet')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const id = randomUUID()
  const idFile = join(dir, 'session-id.txt')
  writeFileSync(idFile, id)
  _cachedSessionId = id
  return id
}

// ── Tool Registry (with all tools registered) ──────────────────

export function createInteractiveToolRegistry(
  refs: RuntimeRefs,
  config: Config,
  cwd: string,
): { registry: ReturnType<typeof createDefaultToolRegistry> } {
  const reg = createDefaultToolRegistry([], { desktopTools: config.agent.desktopTools })

  // delegate_task
  reg.register(createDelegateTaskTool(
    {
      delegate: async (request) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegate(request)
      },
    },
    () => refs.claimStore ?? undefined,
    () => refs.sessionId ?? undefined,
  ))

  // undo
  reg.register(createUndoTool(() => refs.fileHistory ?? undefined))

  // delegate_batch
  reg.register(createDelegateBatchTool(
    {
      delegateBatch: async (requests, policy, abortSignal, onProgress) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
      },
    },
    () => refs.claimStore ?? undefined,
    () => refs.sessionId ?? undefined,
  ))

  // team_orchestrate
  reg.register(createTeamOrchestrateTool({
    delegate: async (request, abortSignal) => {
      if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
      return refs.coordinator.delegate(request, abortSignal)
    },
    delegateBatch: async (requests, policy, abortSignal, onProgress) => {
      if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
      return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
    },
    recordTeamWaveTelemetry: (event: TeamWaveTelemetry) => {
      persistTeamWaveTelemetry(refs.meridianIndexer?.getDb(), event)
    },
    recordTeamWaveRewardClosure: (event: TeamWaveTelemetry) => {
      recordTeamWaveRewardClosure(refs.meridianIndexer?.getDb(), event)
    },
    recordTeamSchedulerShadow: (event: TeamSchedulerShadowEvent) => {
      persistTeamSchedulerShadow(refs.meridianIndexer?.getDb(), event)
    },
    recordGatedInfluenceAudit: (event: GatedInfluenceAuditEvent) => {
      persistGatedInfluenceAudit(refs.meridianIndexer?.getDb(), event)
    },
    recordTeamSchedulerReward: (event: TeamWaveTelemetry) => {
      const rewardInput = deriveTeamWaveRewardInput(event)
      persistTeamSchedulerReward(refs.meridianIndexer?.getDb(), buildTeamSchedulerRewardEvent({
        sessionId: event.sessionId,
        objective: event.objectiveHash,
        waveId: event.waveId,
        arm: teamSchedulerArmForParallelism(event.outcome.dispatched),
        rewardInput: {
          teamWaveReward: computeTeamWaveReward(rewardInput),
          conflictRate: Number(rewardInput.normalizedConflict),
          scopeLeakRate: Number(rewardInput.normalizedScopeLeak),
          falseGreen: rewardInput.falseGreen,
        },
        timestamp: event.timestamp,
      }))
    },
    getTeamSchedulerRewardStore: () => refs.meridianIndexer?.getDb(),
    isTeamSchedulerBanditEnabled: () => resolveBanditPromotion({
      source: 'team_scheduler_bandit',
      mode: effectiveBanditMode(config.agent.banditPromotion?.teamScheduler, config.agent.teamSchedulerBanditEnabled, config.agent.banditPromotion?.killSwitch),
      store: refs.meridianIndexer?.getDb(),
    }).enabled,
    getSessionId: () => refs.sessionId ?? undefined,
  }))

  // recall_capsule
  reg.register(createRecallCapsuleTool(() => cwd))

  // ask_user_question
  reg.register(ASK_USER_QUESTION_TOOL)

  // repo_graph
  reg.register(createRepoGraphTool(() => refs.meridianIndexer))

  // B1 deliver_task
  const b1TaskLedger = createTaskLedger({ taskId: getOrCreateSessionId() })
  refs.taskLedger = b1TaskLedger
  const b1Baseline = createWorktreeBaseline(captureGitBaseline(cwd))
  const b1Ownership = createOwnershipLedger({
    baseline: b1Baseline,
    taskLedger: b1TaskLedger,
  })
  refs.ownershipLedger = b1Ownership
  const b1Attribution = createVerificationAttribution({ ownership: b1Ownership })
  const b1Gate = createDeliveryGateV2({
    taskLedger: b1TaskLedger,
    ownership: b1Ownership,
    attribution: b1Attribution,
  })
  refs.deliveryGate = b1Gate
  reg.register(createDeliverTaskTool((params) => ({
    taskLedger: b1TaskLedger,
    ownership: b1Ownership,
    gate: b1Gate,
    sessionRegistry: refs.sessionRegistry ?? undefined,
    sessionId: refs.sessionId ?? undefined,
    reviewDepth: params?.reviewDepth ?? 0,
    reviewDeps: createCoordinatorReviewDeps({
      delegate: async (request, abortSignal) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegate(request, abortSignal)
      },
      delegateBatch: async (requests, policy, abortSignal, onProgress) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
      },
    }, { reviewDepth: params?.reviewDepth ?? 0 }),
  })))

  return { registry: reg }
}

// ── Agent Runtime ──────────────────────────────────────────────

export function createAgentRuntime(deps: {
  provider: ProviderConfig
  apiKey: string
  auth: AuthProvider | undefined
  config: Config
  sessionId: string
  cwd: string
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  persist: SessionPersist
  claimStore: import('./context/claim-store.js').ContextClaimStore
  fileHistory: FileHistory
  refs: RuntimeRefs
  domainKnowledgeStore: DomainKnowledgeStore
  modelId?: string
}): { agent: AgentLoop } {
  const {
    provider, apiKey, auth, config, sessionId, cwd,
    toolRegistry, persist, claimStore, fileHistory, refs,
    domainKnowledgeStore, modelId,
  } = deps

  const currentModel = modelId
    ? (provider.models.find(m => m.id === modelId || m.alias === modelId) ?? provider.models[0]!)
    : provider.models[0]!

  const agentCfg = createAgentConfig(createMainAgentConfigInput({
    apiKey,
    model: {
      id: currentModel.id,
      maxTokens: currentModel.maxTokens,
      contextWindow: currentModel.contextWindow,
      reasoningEffort: currentModel.reasoningEffort,
    },
    cwd,
    provider,
    config,
    sessionId,
    toolDefinitions: toolRegistry.getDefinitions(),
    sessionMemoryBlock: persist.buildMemoryBlock(),
    auth,
  }))

  // Model capability cards
  const modelCards: ModelCapabilityCard[] = provider.models.map(m => {
    const isPro = m.id.includes('pro') || m.alias?.includes('pro')
    const isFlash = m.id.includes('flash') || m.alias?.includes('flash')
    if (isPro || (!isFlash && !isPro)) {
      return {
        model: m.id,
        toolUseReliability: 0.8,
        jsonStability: 0.8,
        editSuccessRate: 0.7,
        testRepairRate: 0.6,
        contextWindow: m.contextWindow,
        cacheEconomics: 'strong' as const,
        recommendedTasks: ['code_search', 'code_edit', 'test_failure_diagnosis', 'risky_refactor'],
      }
    }
    return {
      model: m.id,
      toolUseReliability: 0.6,
      jsonStability: 0.65,
      editSuccessRate: 0.5,
      testRepairRate: 0.45,
      contextWindow: m.contextWindow,
      cacheEconomics: 'strong' as const,
      recommendedTasks: ['repo_summarization', 'compaction'],
    }
  })

  // Worker routing
  const workerRouting = config.workers?.profiles && Object.keys(config.workers.profiles).length > 0
    ? { profiles: config.workers.profiles, routing: config.workers.routing, providers: config.provider.providers }
    : undefined

  // Physarum provider health: shared between main loop (sensorium stability)
  // and coordinator (cold-tier routing skip). Stream outcomes feed weights.
  const providerHealth = new ProviderHealthTracker()
  providerHealth.registerProvider(provider.name)
  if (workerRouting?.providers) {
    for (const name of Object.keys(workerRouting.providers)) providerHealth.registerProvider(name)
  }

  const runtimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => {
    const writeProfiles = profileRegistry.listWriteProfiles()
    const isWrite = writeProfiles.includes(_order.profile)

    let workerProvider = provider
    let workerApiKey = apiKey
    let workerAuth = auth
    let workerModel = card.model

    if (workerRouting) {
      const routeName = workerRouting.routing[mapWorkOrderKindToCapabilityTask(_order.kind)]
      if (routeName && workerRouting.profiles[routeName]) {
        const routeProfile = workerRouting.profiles[routeName]
        const resolved = config.provider.providers[routeProfile.provider]
        if (resolved && routeProfile.model === card.model) {
          try {
            if (resolved.auth?.type === 'oauth') {
              const routedAuth = resolved.name === provider.name
                ? auth
                : createAuthProvider(resolved.auth, process.env)
              if (routedAuth?.isAuthenticated()) {
                workerProvider = resolved
                workerApiKey = ''
                workerAuth = routedAuth
              }
            } else {
              workerProvider = resolved
              workerApiKey = resolveApiKey(resolved)
              workerAuth = undefined
            }
          } catch {
            workerProvider = provider
            workerApiKey = apiKey
            workerAuth = auth
          }
        }
      }
    }

    if (!workerProvider.models.some(m => m.id === workerModel || m.alias === workerModel)) {
      workerModel = currentModel.id
    }
    const workerModelSpec = workerProvider.models.find(m => m.id === workerModel || m.alias === workerModel)
    const workerContextWindow = workerModelSpec?.contextWindow ?? card.contextWindow
    const workerMaxTokens = isWrite
      ? Math.min(8192, workerModelSpec?.maxTokens ?? workerContextWindow)
      : Math.min(4096, workerModelSpec?.maxTokens ?? workerContextWindow)

    debugLog(`[worker-model] runtimeFactory: kind=${_order.kind} profile=${_order.profile} model=${workerModel} provider=${workerProvider.name} contextWindow=${workerContextWindow}`)

    return {
      order: _order,
      client: createProviderClient(workerProvider, resolveCapabilities(workerProvider.name, workerProvider.capabilities), {
        apiKey: workerApiKey,
        model: workerModel,
        reasoningEffort: undefined,
        maxTokens: workerMaxTokens,
        thinkingBudget: isWrite ? 8192 : 4096,
        auth: workerAuth,
      }),
      promptEngine: new PromptEngine({
        model: workerModel,
        maxTokens: workerMaxTokens,
        staticCtx: { tools: workerRegistry.getDefinitions() },
        volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock() },
      }),
      toolRegistry: workerRegistry,
      cwd,
      maxTurns: 8,
      contextWindow: workerContextWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      activeClaims: claimStore.listActiveClaims(),
      domainKnowledgeStore,
    }
  }

  // EFE routing pulls per-turn signals from the agent, which is constructed
  // after the coordinator — bridge via late-bound reference.
  let agentForSignals: AgentLoop | undefined

  // Track 1: unified shadow→gated promotion gate. Evidence is evaluated once
  // per session; `banditPromotion.killSwitch` rolls every path back at once.
  const promo = config.agent.banditPromotion
  const promotionStore = refs.meridianIndexer?.getDb()
  const modelTierGate = resolveBanditPromotion({
    source: 'model_tier_bandit',
    mode: effectiveBanditMode(promo?.modelTier, config.agent.modelTierBanditEnabled, promo?.killSwitch),
    store: promotionStore,
  })
  const modelRoutingGate = resolveBanditPromotion({
    source: 'model_routing',
    mode: effectiveBanditMode(promo?.modelRouting, config.agent.modelRoutingGatedEnabled, promo?.killSwitch),
    store: promotionStore,
  })
  const effortGate = resolveBanditPromotion({
    source: 'effort_bandit',
    mode: effectiveBanditMode(promo?.effort, undefined, promo?.killSwitch),
    store: promotionStore,
  })

  // T5: expose bandit state for /status observability
  refs.banditState = [modelTierGate, modelRoutingGate, effortGate].map(g => ({
    source: g.source,
    mode: g.mode,
    enabled: g.enabled,
    reason: g.reason,
    totalShadowSamples: g.evidence.totalShadowSamples,
  }))

  refs.coordinator = new DelegationCoordinator({
    baseToolRegistry: toolRegistry,
    modelCards,
    maxWorkers: 3,
    runtimeFactory,
    routing: workerRouting,
    providerHealth,
    domainKnowledgeStore,
    modelTierShadowStore: refs.meridianIndexer?.getDb(),
    modelTierBanditEnabled: modelTierGate.enabled,
    gatedInfluenceAuditStore: refs.meridianIndexer?.getDb(),
    efeRouting: {
      enabled: modelRoutingGate.enabled,
      getSignals: () => agentForSignals?.getPolicySignals(),
    },
    sessionRegistry: refs.sessionRegistry ?? undefined,
    sessionId: refs.sessionId ?? undefined,
    resumeEnabled: true,
  })

  const agent = new AgentLoop(
    {
      ...agentCfg,
      toolRegistry,
      maxTurns: config.agent.maxTurns,
      getSessionMemoryState: () => persist.getSessionMemoryState(),
      fileHistory,
      contextClaimStore: claimStore,
      playbookStore: new PlaybookStore(cwd),
      providerHealth,
      effortBanditEnabled: effortGate.enabled,
      taskLedger: refs.taskLedger ?? undefined,
      ownershipLedger: refs.ownershipLedger ?? undefined,
      // T4: late-bound LSP manager — initialized asynchronously after agent creation
      getLspManager: () => refs.lspManager,
      // Track 3 门禁合一：badge 与收敛检测读权威 v2 状态。
      deliveryGateV2: refs.deliveryGate
        ? (dirty) => refs.deliveryGate!.assess([], dirty)
        : undefined,
      meridianIndexer: refs.meridianIndexer,
      modelRoutingShadowModelCards: modelCards,
      domainKnowledgeStore,
    },
    new SessionContext(),
    cwd,
  )
  agentForSignals = agent

  return { agent }
}

// ── MCP Initialization ─────────────────────────────────────────

export async function initializeMcp(
  config: Config,
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>,
  refs: RuntimeRefs,
): Promise<void> {
  if (!config.mcp.enabled || Object.keys(config.mcp.servers).length === 0) return

  try {
    const { McpManager } = await import('./mcp/manager.js')
    const mgr = new McpManager(config.mcp)
    refs.mcpManager = mgr

    await mgr.initialize()
    const mcpTools = mgr.getAllTools()
    for (const tool of mcpTools) {
      toolRegistry.register(tool)
    }

    const states = mgr.getStates()
    const connected = states.filter(s => s.status === 'connected')
    const failed = states.filter(s => s.status === 'error')
    if (connected.length > 0 || failed.length > 0) {
      const parts: string[] = []
      if (connected.length > 0) {
        const toolCount = connected.reduce((s, c) => s + c.toolCount, 0)
        parts.push(`${connected.length} server(s) connected (${toolCount} tools)`)
      }
      if (failed.length > 0) {
        parts.push(`${failed.length} server(s) failed: ${failed.map(s => `${s.serverId}: ${s.error}`).join(', ')}`)
      }
      console.error(`[MCP] ${parts.join('; ')}`)
    }
  } catch (err) {
    console.error('[MCP] Initialization failed:', (err as Error).message)
  }
}

// ── LSP Initialization ─────────────────────────────────────────

export async function initializeLsp(
  cwd: string,
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>,
): Promise<ReturnType<typeof createLspManager>> {
  const lspManager = createLspManager(
    () => spawn('npx', ['-y', 'typescript-language-server', '--stdio'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    cwd,
  )

  try {
    await lspManager.initialize()
    if (lspManager.isReady()) {
      toolRegistry.register(createGotoDefinitionTool(lspManager))
      toolRegistry.register(createFindReferencesTool(lspManager))
      console.error(
        `[LSP] typescript-language-server ready — ` +
        `definition: ${lspManager.supportsDefinition()}, ` +
        `references: ${lspManager.supportsReferences()}`,
      )
    } else {
      console.error('[LSP] typescript-language-server failed to initialize — tools not registered')
    }
  } catch (err) {
    console.error('[LSP] Initialization error:', (err as Error).message)
  }

  return lspManager
}

// ── Session Infrastructure ─────────────────────────────────────

export async function createSessionInfrastructure(): Promise<{
  registry: import('./agent/session-registry.js').SessionRegistry
  sessionId: string
  heartbeatInterval: ReturnType<typeof setInterval>
}> {
  const stateDir = join(homedir(), '.rivet', 'state')
  const { SessionRegistry } = await import('./agent/session-registry.js')
  const registry = await SessionRegistry.create(stateDir)

  const crashedSessions = registry.detectCrashedSessions()
  if (crashedSessions.length > 0) {
    console.log(`\n🔄 检测到 ${crashedSessions.length} 个异常退出的会话，已清理`)
    for (const cs of crashedSessions) {
      console.log(`   会话 ID: ${cs.id}`)
    }
    const lastCrashed = crashedSessions[0]
    if (lastCrashed) {
      try {
        const persist = new SessionPersist(lastCrashed.id)
        const messages = persist.loadOai()
        console.log(`   ✅ 恢复完成：${messages.length} 条消息\n`)
      } catch (err) {
        console.error(`   ❌ 恢复失败: ${(err as Error).message}`)
        console.log('   启动新会话...')
      }
    }
  }

  const sessionId = getOrCreateSessionId()
  registry.register(sessionId, process.cwd())

  const heartbeatInterval = setInterval(() => {
    try { registry.heartbeat(sessionId) } catch { /* ignore */ }
  }, 10_000).unref()

  return { registry, sessionId, heartbeatInterval }
}

// ── Shutdown Handler ───────────────────────────────────────────

export function createShutdownHandler(ctx: BootstrapContext): () => void {
  let isShuttingDown = false
  return () => {
    if (isShuttingDown) return
    isShuttingDown = true

    try {
      ctx.persist.compactOai(ctx.session.getMessages())
      if (ctx.fileHistory) {
        persistFileHistory(
          join(homedir(), '.rivet', 'sessions', ctx.sessionId, 'file-history.json'),
          ctx.fileHistory.getAllSnapshots(),
        )
      }
      ctx.agent.flushStigmergySync()
      ctx.agent.abort()
    } catch (err) {
      try { process.stderr.write(`[shutdown] callback error: ${(err as Error)?.message}\n`) } catch { /* noop */ }
    } finally {
      if (ctx.heartbeatInterval) clearInterval(ctx.heartbeatInterval)
      try { ctx.refs.lspManager?.dispose() } catch { /* best-effort */ }
      try { ctx.refs.mcpManager?.killChildrenSync?.() } catch { /* best-effort */ }
      void ctx.refs.mcpManager?.shutdown?.()
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false)
      }
      killAllSync()
      // Note: does NOT call process.exit — callers should do so after additional cleanup
    }
  }
}

// ── Model Switch (T9 + React 共用) ─────────────────────────────

export interface SwitchModelResult {
  ok: boolean
  error?: string
  /** 成功时返回的展示名（alias 优先）与上下文窗口，供 UI 刷新 */
  modelName?: string
  contextWindow?: number
}

/**
 * 跨 provider 查找并切换模型 —— 重建 AgentLoop（与 React main.tsx 的 useMemo 重建同构，
 * 不存在仅热换 client 的轻量路径）。成功时**原地更新** ctx 的 agent/provider/apiKey/auth，
 * 使所有持有 ctx 引用的闭包（onSubmit/onAbort）自动用上新 agent。
 *
 * session / persist / toolRegistry / refs / fileHistory 等全部复用，前缀缓存与历史不受影响。
 */
export function switchAgentRuntime(ctx: BootstrapContext, modelId: string): SwitchModelResult {
  // 切换前记录当前模型 id，供 JSONL 审计事件的 from 字段。
  let fromModel: string | undefined
  try { fromModel = ctx.agent.config.promptEngine.getModel() } catch { /* idle/未初始化 */ }
  for (const [provName, prov] of Object.entries(ctx.config.provider.providers)) {
    const found = prov.models.find(m => m.id === modelId || m.alias === modelId)
    if (!found) continue

    let provider = ctx.provider
    let apiKey = ctx.apiKey
    let auth = ctx.auth

    if (prov.auth?.type === 'oauth') {
      if (provName !== ctx.provider.name) {
        provider = prov
        apiKey = ''
        auth = createAuthProvider(prov.auth, process.env, prov.apiKey)
      }
    } else {
      const provKey = prov.apiKey ?? process.env[prov.apiKeyEnv ?? ''] ?? (() => {
        try { return resolveApiKey(prov) } catch { return undefined }
      })()
      if (!provKey) {
        return { ok: false, error: `API key not set for ${provName}. Set ${prov.apiKeyEnv ?? 'apiKey'} in config or environment.` }
      }
      if (provName !== ctx.provider.name) {
        provider = prov
        apiKey = provKey
        auth = undefined
      }
    }

    const { agent } = createAgentRuntime({
      provider,
      apiKey,
      auth,
      config: ctx.config,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      toolRegistry: ctx.toolRegistry,
      persist: ctx.persist,
      claimStore: ctx.claimStore,
      fileHistory: ctx.fileHistory,
      refs: ctx.refs,
      domainKnowledgeStore: ctx.domainKnowledgeStore,
      modelId: found.id,
    })

    ctx.agent = agent
    ctx.provider = provider
    ctx.apiKey = apiKey
    ctx.auth = auth

    // 持久化切换：metadata.model/provider 反映当前模型（会话恢复/列表显示用），
    // 并在 JSONL 落一条审计事件（每次切换可溯源）。best-effort，不阻塞切换。
    try {
      ctx.persist.updateMetadata({ model: found.id, provider: provName })
      ctx.persist.appendModelSwitch({ from: fromModel, to: found.id, provider: provName })
    } catch { /* persistence is best-effort — never block a model switch */ }

    return { ok: true, modelName: found.alias ?? found.id, contextWindow: found.contextWindow }
  }
  return { ok: false, error: `Model "${modelId}" not found in any provider.` }
}

// ── Aggregate Bootstrap ────────────────────────────────────────

export interface BootstrapOptions {
  cwd?: string
  args?: string[]
  modelId?: string
  providerName?: string
  /** If true, MCP and LSP are initialized asynchronously (non-blocking) */
  asyncExtras?: boolean
}

/**
 * 一站式初始化 — 返回 BootstrapContext。
 *
 * main-ansi.ts 直接 await 调用。
 * main.tsx 在 React hooks 内部调用（handleShutdown 使用返回的 shutdown）。
 */
export async function bootstrapInteractiveSession(opts: BootstrapOptions = {}): Promise<BootstrapContext> {
  const cwd = opts.cwd ?? process.cwd()

  // 1. HTTP Proxy
  setupHttpProxy()

  // 2. Config
  const config = loadRivetConfig(cwd, opts.args)

  // 3. Provider + Auth
  const { provider, apiKey, auth } = resolveProviderAndAuth(config, opts.providerName)

  // 4. Session infrastructure
  const { registry: sessionRegistry, sessionId, heartbeatInterval } = await createSessionInfrastructure()

  // 5. Session persist + claim store
  const persist = new SessionPersist(sessionId)
  const claimStore = persist.createClaimStore()
  persist.injectDurableClaims(claimStore, cwd)
  for (const rule of loadProjectRules(cwd)) {
    claimStore.propose(rule)
  }
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const session = new SessionContext()

  // Load prior messages
  const existingMessages = persist.loadOai()
  if (existingMessages.length > 0) {
    session.replaceMessages(existingMessages)
  }

  // Evict old sessions
  evictOldSessions(sessionId)

  // Clean up orphaned files
  const rivetDir = join(cwd, '.rivet')
  const dirsToScan = [
    rivetDir,
    join(rivetDir, 'sessions'),
    join(rivetDir, 'artifacts'),
    join(rivetDir, 'checkpoints'),
  ]
  const tmpCleaned = cleanupOrphanedTmpFiles(dirsToScan)
  if (tmpCleaned > 0) {
    console.error(`[startup] Cleaned ${tmpCleaned} orphaned .tmp file(s)`)
  }
  const artifactCleaned = cleanupOldArtifactSessions(join(rivetDir, 'artifacts'), sessionId)
  if (artifactCleaned > 0) {
    console.error(`[startup] Cleaned ${artifactCleaned} old artifact session(s)`)
  }

  // 6. Meridian indexer
  const meridianIndexer = new MeridianIndexer(cwd)

  // 7. Domain knowledge store
  const domainKnowledgeStore = new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))

  // 8. Load profiles + star domains
  const agentsDir = join(cwd, '.rivet', 'agents')
  const agentLoadResult = profileRegistry.loadFromDirectory(agentsDir)
  if (agentLoadResult.loaded.length > 0 || agentLoadResult.errors.length > 0) {
    for (const err of agentLoadResult.errors) {
      console.warn(`[agents] ${err}`)
    }
  }
  const domainsDir = join(cwd, '.rivet', 'domains')
  const domainLoadResult = starDomainRegistry.loadFromDirectory(domainsDir)
  if (domainLoadResult.errors.length > 0) {
    for (const err of domainLoadResult.errors) {
      console.warn(`[domains] ${err}`)
    }
  }

  // 9. Runtime refs
  const refs: RuntimeRefs = {
    coordinator: null,
    fileHistory,
    claimStore,
    sessionId,
    sessionRegistry,
    taskLedger: null,
    ownershipLedger: null,
    deliveryGate: null,
    meridianIndexer,
    mcpManager: null,
    lspManager: null,
    banditState: null,
  }

  // 10. Tool registry
  const { registry: toolRegistry } = createInteractiveToolRegistry(refs, config, cwd)

  // 11. Recall + remember tools
  toolRegistry.register(createRecallTool(claimStore, {
    sessionId,
    getTurn: () => session.getTurnCount(),
  }))
  toolRegistry.register(createRememberTool(claimStore, {
    sessionId,
    getTurn: () => session.getTurnCount(),
    cwd,
  }))

  // 12. Agent runtime
  const { agent } = createAgentRuntime({
    provider, apiKey, auth, config, sessionId, cwd,
    toolRegistry, persist, claimStore, fileHistory, refs,
    domainKnowledgeStore, modelId: opts.modelId,
  })

  // 13. MCP + LSP initialization
  // asyncExtras (default true): fire-and-forget, non-blocking for faster startup
  // asyncExtras=false: synchronous await, completes before bootstrap returns
  if (opts.asyncExtras !== false) {
    initializeMcp(config, toolRegistry, refs).then(() => {
      agent.updateTools()
    }).catch(() => {})
    initializeLsp(cwd, toolRegistry).then((lspManager) => {
      refs.lspManager = lspManager
      agent.updateTools()
    }).catch(() => {})
  } else {
    await initializeMcp(config, toolRegistry, refs)
    agent.updateTools()
    const lsp = await initializeLsp(cwd, toolRegistry)
    refs.lspManager = lsp
    agent.updateTools()
  }

  // 14. Shutdown handler
  const shutdown = createShutdownHandler({
    config, provider, apiKey, auth, sessionId, session, persist,
    claimStore, fileHistory, toolRegistry, agent, refs,
    domainKnowledgeStore, meridianIndexer, cwd,
    shutdown: () => {}, // placeholder, replaced below
    heartbeatInterval,
  })

  const ctx: BootstrapContext = {
    config, provider, apiKey, auth, sessionId, session, persist,
    claimStore, fileHistory, toolRegistry, agent, refs,
    domainKnowledgeStore, meridianIndexer, cwd,
    shutdown,
    heartbeatInterval,
  }

  return ctx
}
