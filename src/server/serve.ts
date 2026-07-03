/**
 * `rivet serve` — HTTP+SSE Runtime API entry, extracted from the legacy Ink
 * entry so it ships from the release build (`dist/main.js`). Used directly as a
 * localhost sidecar by 天枢桌面版 (desktop/).
 *
 * Guardrails: binds 127.0.0.1 only; Bearer token fail-closed; reuses the
 * existing AgentLoop / ArtifactStore — no runtime rewrite, only an API surface.
 */
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { startServer } from './index.js'
import { desktopDir, desktopSessionsDir } from '../config/paths.js'
import { serverLogger } from './logger.js'
import { createRoutes, type ServerState } from './routes.js'
import { RuntimeSessionManager } from './session-manager.js'
import type { DelegateWorkerInput, DelegateActivityUpdate } from './session-manager.js'
import { activityProgressLine } from '../tools/worker-activity-stream.js'
import { FileSessionPersistence } from './session-persistence.js'
import { buildSessionRoutes } from './session-routes.js'
import { buildHealthRoute } from './health-route.js'
import { buildScheduleRoutes } from './schedule-routes.js'
import { buildTaskRoutes } from './task-routes.js'
import { buildConfigRoutes } from './config-routes.js'
import { buildEnvRoute } from './env-route.js'
import { buildProjectTemplatesRoutes } from './project-templates-routes.js'
import { CronScheduler } from './cron-scheduler.js'
import { CronWiring } from './cron-wiring.js'
import { buildMcpRoutes } from './mcp-api.js'
import { McpManager } from '../mcp/manager.js'
import { CronLock } from './cron-lock.js'
import { TaskRegistry } from './task-registry.js'
import { JsonTaskStore } from './task-store.js'
import { SessionRuntimePool } from './session-runtime-pool.js'
import { loadConfig } from '../config/manager.js'
import { setTargetConventions } from '../platform.js'
import { resolveApiKey } from '../api/factory.js'
import { createAuthProvider } from '../auth/registry.js'
import type { AuthProvider } from '../auth/types.js'
import { SessionPersist } from '../agent/session-persist.js'
import { FileHistory } from '../agent/file-history.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { buildOpenPathCommand, buildRevealCommand } from '../tools/open-path.js'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
import { AgentLoop } from '../agent/loop.js'
import type { ApprovalMode } from '../agent/loop-types.js'
import { SessionContext } from '../agent/context.js'
import { SessionRegistry } from '../agent/session-registry.js'
import { createTaskLedger } from '../agent/task-ledger.js'
import { createOwnershipLedger } from '../agent/ownership-ledger.js'
import { createWorktreeBaseline } from '../agent/worktree-baseline.js'
import { captureGitBaseline, createInteractiveToolRegistry, createAgentRuntime, type RuntimeRefs } from '../bootstrap.js'
import { TodoStore } from '../tools/todo-store.js'
import { loadProjectSkills } from '../skills/skill-loader.js'
import { createMemoryTool } from '../tools/memory.js'
import { DomainKnowledgeStore } from '../agent/domain-knowledge-store.js'
import { ProviderHealthTracker } from '../agent/provider-health.js'
import type { Config, ProviderConfig, ModelConfig } from '../config/schema.js'
import { runCouncil, runCouncilDebate, type CouncilInput } from '../agent/council/council-orchestrator.js'
import type { CouncilSeat } from '../agent/council/council-routing.js'
import { renderCouncilPlan, summarizeCouncilPlan } from '../agent/council/council-render.js'
import { DEFAULT_COUNCIL_SEATS } from '../agent/council/council-routing.js'
import { councilPlanToUnifiedPlan } from '../agent/council/council-to-plan.js'
import { serializeUnifiedPlan, deserializeUnifiedPlan, type UnifiedPlan } from '../agent/unified-plan.js'
import { recordCouncilSession } from '../agent/council/council-telemetry.js'
import { persistCouncilRoutingShadow } from '../agent/council/council-routing.js'
import type { PlanItem } from '../agent/council/council-plan.js'

export interface ServeContext {
  config: Config
  provider: ProviderConfig
  model: ModelConfig
  apiKey: string
  auth?: AuthProvider
  /** true when the default provider has a usable API key (inline or env). */
  configured: boolean
}

/**
 * Resolve provider/model/auth/apiKey once at server start. On first launch
 * the user may have no API key configured yet — instead of crashing (which
 * blocks the desktop settings UI from ever being reached), we return a
 * degraded context with apiKey='' and configured=false. The server starts,
 * /config routes accept setup requests, and session creation re-resolves
 * the key from disk at runtime.
 */
export function resolveServeContext(loader: () => Config = loadConfig): ServeContext {
  const config = loader()
  setTargetConventions(config.editor.platform, config.editor.eol)
  const provider = config.provider.providers[config.provider.default]
  if (!provider) {
    throw new Error(`Provider "${config.provider.default}" not configured. Run 'rivet config setup' first.`)
  }

  let auth: AuthProvider | undefined
  let apiKey = ''
  let configured = true
  if (provider.auth?.type === 'oauth') {
    try {
      auth = createAuthProvider(provider.auth, process.env, provider.apiKey)
      if (!auth.isAuthenticated()) configured = false
    } catch {
      configured = false
    }
  } else {
    try {
      apiKey = resolveApiKey(provider)
    } catch {
      // First launch / no env var set — degrade gracefully so the server
      // stays alive and /config routes can receive the key setup.
      configured = false
      console.error(`[serve] No API key configured for provider "${provider.name}". Server started in setup mode — configure via desktop Settings or 'rivet config setup'.`)
    }
  }

  // When the default provider has no models, fall back to the first
  // available model across all providers (or a minimal placeholder) so
  // the UI can still enumerate models in the setup flow.
  const model = provider.models[0]
    ?? Object.values(config.provider.providers)
      .flatMap(p => p.models)[0]
    ?? { id: 'unknown', maxTokens: 4096, contextWindow: 128_000 }

  return { config, provider, model, apiKey, auth, configured }
}

export interface BuiltAgent {
  agent: AgentLoop
  sessionId: string
}

/**
 * Wave J: sidecar 级共享运行时状态——跨 session + switchModel 保持，避免
 * createAgentRuntime per-call new 导致状态丢失。`runServe` 顶层创建一份，
 * 透传给每个 buildManagedAgent / assembleAgentLoop。
 *
 * 当前共享对象：
 * - providerHealth: 进程级单例，所有 session 共享 provider 健康统计
 *   （registerProvider 幂等，重复注册不重置）
 * - domainStores: cwd-keyed 缓存，同 cwd 多 session 复用同一个磁盘绑定的
 *   DomainKnowledgeStore（避免重复 load + 跨 session lessons 可见）
 * - sameCwdRunningCount: late-bound (Wave F)——RuntimeSessionManager 创建后
 *   回写。给 verificationSnapshotManager 做多 session worktree 冲突检测；
 *   修复硬编码 () => 0 假设（TUI 单 session 路径不受影响，sidecar 走真实计数）。
 *
 * 未来候选：bandit gates evaluation 结果缓存（避免 switchModel 重算）。
 */
export interface SharedRuntime {
  providerHealth: ProviderHealthTracker
  domainStores: Map<string, DomainKnowledgeStore>
  /** late-bound: 在 sessions = new RuntimeSessionManager(...) 之后由 runServe
   *  回写。值为 null 时退化为 0（sessions 尚未初始化的窗口期）。 */
  sameCwdRunningCount: ((cwd: string, excludeSessionId?: string) => number) | null
  /** Server-level MCP manager — one connection pool for all sessions. */
  mcpManager: McpManager | null
  /** I4: late-bound RuntimeSessionManager so hooks can emit `hook_result` events. */
  sessions: RuntimeSessionManager | null
}

/** sidecar 内部：按 cwd 取/建 DomainKnowledgeStore，多 session 共享同一实例。 */
function getOrCreateDomainStore(shared: SharedRuntime, cwd: string): DomainKnowledgeStore {
  const existing = shared.domainStores.get(cwd)
  if (existing) return existing
  const store = new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))
  shared.domainStores.set(cwd, store)
  return store
}

/**
 * A resolved provider/model/auth tuple for one model id — the cross-provider
 * lookup result that switchModel rebuilds an agent on. Mirrors the resolution
 * logic in bootstrap.switchAgentRuntime (provider/OAuth/apiKey handling).
 */
export interface ResolvedModelSpec {
  provider: ProviderConfig
  apiKey: string
  auth?: AuthProvider
  model: { id: string; maxTokens: number; contextWindow: number; reasoningEffort?: ModelConfig['reasoningEffort'] }
}

/**
 * Resolve a model id (or alias) to its provider/apiKey/auth/model spec, scanning
 * every configured provider. Returns null when the id is unknown or the target
 * provider has no usable API key (kept fail-closed, like switchAgentRuntime).
 */
export function resolveModelSpec(ctx: ServeContext, modelId: string): ResolvedModelSpec | null {
  for (const [provName, prov] of Object.entries(ctx.config.provider.providers)) {
    const found = prov.models.find((m) => m.id === modelId || m.alias === modelId)
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
      const provKey =
        prov.apiKey ??
        process.env[prov.apiKeyEnv ?? ''] ??
        (() => { try { return resolveApiKey(prov) } catch { return undefined } })()
      if (!provKey) return null
      if (provName !== ctx.provider.name) {
        provider = prov
        apiKey = provKey
        auth = undefined
      }
    }

    return {
      provider,
      apiKey,
      auth,
      model: {
        id: found.id,
        maxTokens: found.maxTokens,
        contextWindow: found.contextWindow,
        reasoningEffort: found.reasoningEffort,
      },
    }
  }
  return null
}

/**
 * Resolve a model id against the startup `ctx`, falling back to a fresh on-disk
 * read when the snapshot can't resolve it. On first install the server starts in
 * setup mode (configured=false, no API key) and the user configures the key via
 * /config afterwards — the startup snapshot then can't find a key for the target
 * model, which would make switchModel 409 until restart. Re-reading config on the
 * miss path (mirrors resolveInitialSpec) also covers providers added/edited via
 * Settings after startup. Cheap: the fresh read only happens on the rare miss.
 */
export function resolveModelSpecWithReload(
  ctx: ServeContext,
  modelId: string,
  reload: () => ServeContext = resolveServeContext,
): ResolvedModelSpec | null {
  const fromSnapshot = resolveModelSpec(ctx, modelId)
  if (fromSnapshot) return fromSnapshot
  try {
    return resolveModelSpec(reload(), modelId)
  } catch {
    return null
  }
}

/** Enumerate every selectable model across all configured providers. */
export function listAllModels(ctx: ServeContext): { id: string; alias: string; provider: string; contextWindow?: number }[] {
  const out: { id: string; alias: string; provider: string; contextWindow?: number }[] = []
  for (const [provName, prov] of Object.entries(ctx.config.provider.providers)) {
    for (const m of prov.models) {
      out.push({ id: m.id, alias: m.alias ?? m.id, provider: provName, contextWindow: m.contextWindow })
    }
  }
  return out
}

/**
 * Enumerate selectable models for the picker, preferring a fresh on-disk read
 * so providers added/edited via Settings *after* startup show up without a
 * restart — the companion to resolveModelSpecWithReload (which makes the actual
 * switch resolve the freshly-configured key). The startup snapshot is only a
 * fallback for the degraded case where the fresh read throws (e.g. a missing
 * default provider mid-edit). Called on picker open — low frequency, so the
 * extra config read is negligible.
 */
export function listAllModelsWithReload(
  ctx: ServeContext,
  reload: () => ServeContext = resolveServeContext,
): { id: string; alias: string; provider: string; contextWindow?: number }[] {
  try {
    return listAllModels(reload())
  } catch {
    return listAllModels(ctx)
  }
}

/**
 * Per-session, model-independent pieces. Built once and reused across model
 * rebuilds so switchModel preserves conversation (same SessionContext) and
 * shared stores (claims/file-history/playbook/tools/ledgers).
 */
interface SessionStores {
  persist: SessionPersist
  claimStore: ReturnType<SessionPersist['createClaimStore']>
  fileHistory: FileHistory
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  session: SessionContext
  taskLedger: ReturnType<typeof createTaskLedger>
  ownershipLedger: ReturnType<typeof createOwnershipLedger>
  /** RuntimeRefs 在 createInteractiveToolRegistry 中被工具体内闭包持有；
   *  Wave C: assembleAgentLoop 通过 createAgentRuntime 装配 coordinator 后
   *  回写 refs.coordinator，让 5 个 coordinator 依赖工具激活。 */
  refs: RuntimeRefs
}

// playbookStore 由 createAgentRuntime 内部自管（bootstrap.ts:726
// `playbookStore: new PlaybookStore(cwd)`），sidecar 不再代为构造——
// 历史 Wave A 短暂保留的 stores.playbookStore 是死字段，Wave C 后无消费者，已删。

function buildSessionStores(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  registry?: SessionRegistry,
  shared?: SharedRuntime,
): SessionStores {
  const persist = new SessionPersist(sessionId, cwd)
  const claimStore = persist.createClaimStore()
  persist.injectDurableClaims(claimStore)
  for (const rule of loadProjectRules(cwd)) claimStore.propose(rule)
  // Load skills into the shared registry (same as CLI bootstrap). Without this,
  // skillRegistry.list() returns empty and the desktop PlusMenu shows no skills.
  loadProjectSkills(cwd, { importFromClaude: ctx.config.skills?.importFromClaude })
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const session = new SessionContext()

  // sidecar 工具装配——复用 bootstrap 的 createInteractiveToolRegistry，与 TUI 端
  // 共享一套装配链。Wave C 后所有工具（含 coordinator 依赖工具）均通过
  // refs 闭包后绑定 coordinator，assembleAgentLoop 通过 createAgentRuntime
  // 装配 coordinator 后回写 refs.coordinator，工具被激活。
  const refs: RuntimeRefs = {
    coordinator: null,
    fileHistory,
    claimStore,
    sessionId,
    sessionRegistry: registry ?? null,
    taskLedger: null,
    ownershipLedger: null,
    verificationSnapshotManager: null,
    deliveryGate: null,
    meridianIndexer: null,
    mcpManager: null,
    lspManager: null,
    banditState: null,
    promptEngine: null,
    // Wave F: 通过 SharedRuntime → RuntimeSessionManager.sameCwdRunningCount
    // 注入真实计数；shared 缺失或 manager 未就绪退化为 0（保持 TUI 兼容行为）。
    getSameCwdRunningSessions: shared
      ? () => shared.sameCwdRunningCount?.(cwd, sessionId) ?? 0
      : undefined,
    goalTrackerRef: { current: null },
    // 多会话隔离：每会话独立内存态 TodoStore，杜绝并发会话清单串台（提示词注入污染）。
    // 不做磁盘持久化（按决策），展示与跨重启恢复靠事件日志重放。
    todoStore: new TodoStore(),
  }
  const { registry: toolRegistry } = createInteractiveToolRegistry(refs, ctx.config, cwd)

  // memory (unified recall + remember)：bootstrap 在 createInteractiveToolRegistry 外装的工具，
  // 这里复用 sidecar 已有的 claimStore + session 完成对齐。
  toolRegistry.register(createMemoryTool(claimStore, {
    sessionId,
    getTurn: () => session.getTurnCount(),
    cwd,
  }))

  // taskLedger / ownershipLedger 由 createInteractiveToolRegistry 的 B1 装配段
  // 原地填入 refs；fallback 仅用于装配失败时不破坏 assembleAgentLoop 的 deps。
  const taskLedger = refs.taskLedger ?? createTaskLedger({ taskId: sessionId })
  const ownershipLedger = refs.ownershipLedger ?? createOwnershipLedger({
    baseline: createWorktreeBaseline(captureGitBaseline(cwd)),
    taskLedger,
  })

  // Register MCP tools (if the server-level manager has already initialized).
  // Late-init: sessions created before MCP finishes connecting won't get MCP
  // tools, but subsequent sessions will.
  const mcpMgr = shared?.mcpManager
  if (mcpMgr) {
    const mcpTools = mcpMgr.getAllTools()
    for (const tool of mcpTools) {
      toolRegistry.register(tool)
    }
  }

  return { persist, claimStore, fileHistory, toolRegistry, session, taskLedger, ownershipLedger, refs }
}

/**
 * Assemble an AgentLoop from prebuilt session stores + a resolved model spec.
 * Reusing `stores.session` across calls is what lets switchModel hot-swap the
 * model while keeping the conversation history intact.
 *
 * Wave C: 通过 bootstrap.createAgentRuntime 装配——它会构造 DelegationCoordinator
 * 并填到 stores.refs.coordinator，激活之前注册占位的 5 个 coordinator 依赖工具
 * （delegate_task / delegate_batch / team_orchestrate / council_convene /
 * plan_task）以及 deliver_task 的审查 worker spawn 路径。与 TUI bootstrap 路径
 * 共享同一份装配逻辑，行为完全等价。
 */
function assembleAgentLoop(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  stores: SessionStores,
  spec: ResolvedModelSpec,
  approvalMode: ApprovalMode | undefined,
  registry?: SessionRegistry,
  shared?: SharedRuntime,
): AgentLoop {
  // Wave J: domainKnowledgeStore 优先从 sidecar SharedRuntime.domainStores
  // 按 cwd 取；fallback 是 per-call new（与 bootstrap 单 session 行为一致——
  // 用于 buildAgentLoop legacy /prompt 路径未传 shared 的情况）。
  const domainKnowledgeStore = shared
    ? getOrCreateDomainStore(shared, cwd)
    : new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))

  // sessionRegistry 透传：bootstrap.createAgentRuntime 通过 refs.sessionRegistry
  // 间接接到 AgentLoop，所以在调装配前先回写 refs（buildSessionStores 已经接收
  // 过 registry，但 switchModel 重建路径需要在每次调用都确保 refs 同步）。
  if (registry) stores.refs.sessionRegistry = registry

  const { agent } = createAgentRuntime({
    provider: spec.provider,
    apiKey: spec.apiKey,
    auth: spec.auth,
    config: ctx.config,
    sessionId,
    cwd,
    toolRegistry: stores.toolRegistry,
    persist: stores.persist,
    claimStore: stores.claimStore,
    fileHistory: stores.fileHistory,
    refs: stores.refs,
    domainKnowledgeStore,
    modelId: spec.model.id,
    session: stores.session,
    // Wave J: 跨 session 复用 ProviderHealthTracker，让 switchModel 不丢
    // provider 健康累积；coordinator 冷层路由有正确依据。
    sharedProviderHealth: shared?.providerHealth,
    // I4: user hook results → desktop event stream via the session manager.
    emitHookResult: (results, meta) => shared?.sessions?.emitHookResult(sessionId, results, meta),
  })

  // approvalMode 在 createAgentRuntime 内部未接收；构造后立即覆盖
  // （setApprovalMode 直接 mutate config.approvalMode，与构造时设等价）。
  if (approvalMode) agent.setApprovalMode(approvalMode)

  return agent
}

/**
 * Build a fully-wired AgentLoop for one session rooted at `cwd`. Each call gets
 * its own SessionPersist / claim store / FileHistory / PlaybookStore / tool
 * registry / PromptEngine (via createAgentConfig) and its own ArtifactStore
 * (created internally by AgentLoop, keyed by sessionId) — so concurrent
 * sessions never share prompt cache state or artifacts.
 *
 * R1: when a shared `registry` is supplied (desktop multi-session path), each
 * session also gets its own TaskLedger + OwnershipLedger and the registry is
 * threaded into AgentLoop config so file claims / OwnershipGuard / cross-session
 * conflict blocking become live. Omitting `registry` (CLI / single-session)
 * keeps the previous behavior byte-for-byte.
 */
/**
 * Resolve the initial model spec for a new session. When the server started
 * in setup mode (ctx.configured=false), the user may have since configured
 * an API key via /config routes — re-read from disk to pick it up. Falls
 * back to ctx.apiKey when the key is still unavailable.
 */
function resolveInitialSpec(ctx: ServeContext): ResolvedModelSpec {
  if (ctx.configured) {
    return {
      provider: ctx.provider,
      apiKey: ctx.apiKey,
      auth: ctx.auth,
      model: { id: ctx.model.id, maxTokens: ctx.model.maxTokens, contextWindow: ctx.model.contextWindow, reasoningEffort: ctx.model.reasoningEffort },
    }
  }
  // Re-read config — the user may have called POST /config/providers since startup.
  const fresh = resolveServeContext()
  return {
    provider: fresh.provider,
    apiKey: fresh.apiKey,
    auth: fresh.auth,
    model: { id: fresh.model.id, maxTokens: fresh.model.maxTokens, contextWindow: fresh.model.contextWindow, reasoningEffort: fresh.model.reasoningEffort },
  }
}

export function buildAgentLoop(
  ctx: ServeContext,
  cwd: string,
  sessionId: string = randomUUID(),
  registry?: SessionRegistry,
  approvalMode?: ApprovalMode,
  shared?: SharedRuntime,
): BuiltAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId, registry, shared)
  const spec = resolveInitialSpec(ctx)
  const agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry, shared)
  return { agent, sessionId }
}

/**
 * Build a ManagedAgent whose underlying AgentLoop can be hot-swapped onto a new
 * model (switchModel) without losing the conversation. The shared SessionStores
 * (including SessionContext) are built once; switchModel re-assembles only the
 * AgentLoop on a freshly resolved model spec and re-points the holder, so every
 * delegating method below transparently uses the live agent.
 */
function buildManagedAgent(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  registry: SessionRegistry | undefined,
  approvalMode: ApprovalMode | undefined,
  shared?: SharedRuntime,
): import('./session-manager.js').ManagedAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId, registry, shared)
  let spec: ResolvedModelSpec = resolveInitialSpec(ctx)
  let agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry, shared)
  return {
    run: (prompt, callbacks, images) => agent.run(prompt, callbacks, images),
    abort: () => agent.abort(),
    setApprovalMode: (mode) => agent.setApprovalMode(mode),
    enterPlanMode: () => agent.enterPlanMode(),
    exitPlanMode: () => agent.exitPlanMode(),
    setActivePlan: (plan) => agent.setActivePlan(plan),
    listArtifacts: () => agent.artifactStore?.list() ?? [],
    readArtifact: (artifactId) => agent.artifactStore?.readRaw(artifactId) ?? Promise.resolve(null),
    getMessages: () => agent.session.getMessages(),
    replaceMessages: (msgs) => { agent.session.replaceMessages(msgs); agent.config.promptEngine.resetAppendixBaseline() },
    rewindToMessages: (msgs) => { agent.session.rewindToMessages(msgs); agent.config.promptEngine.resetAppendixBaseline() },
    getFileHistory: () => agent.getFileHistory(),
    // PlusMenu — star domain (delegate to the live agent).
    setSessionDomain: (domain) => agent.setSessionDomain(domain),
    resetSessionDomain: () => agent.resetSessionDomain(),
    getSessionDomain: () => agent.getSessionDomain(),
    // PlusMenu — skills (per-session discovery filter on the live agent).
    setDisabledSkills: (names) => agent.setDisabledSkills(names),
    // PlusMenu — model hot-switch (rebuild on the same SessionContext).
    // Wave C-followup P0: createAgentRuntime 在 refs 上原地装新 coordinator/
    // providerHealth/runtimeFactory，但旧 coordinator 的 stallSweep 定时器与
    // 在途 worker AbortController 仍持有句柄。sidecar 长驻进程 + 频繁
    // switchModel 会累积泄漏。先 capture old，装新后调 shutdown 释放。
    // Wave J: 透传 shared 让 switchModel 后仍复用 providerHealth/domainStore，
    // 健康数据不丢、knowledge 不重 load。
    switchModel: (modelId) => {
      // First-install / post-startup config edits: resolve against the live
      // config, not just the startup snapshot. See resolveModelSpecWithReload.
      const next = resolveModelSpecWithReload(ctx, modelId)
      if (!next) return null
      const oldCoordinator = stores.refs.coordinator
      // Cancel the outgoing loop's idle compaction: it shares this SessionContext
      // with the incoming loop, so a pending idle timer would race the new agent.
      const oldAgent = agent
      void oldAgent.cancelIdleCompaction()
      spec = next
      agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry, shared)
      if (oldCoordinator && oldCoordinator !== stores.refs.coordinator) {
        try { oldCoordinator.shutdown() } catch { /* best-effort: shutdown is fail-open */ }
      }
      return spec.model.id
    },
    // Context usage display (desktop header progress bar) — real occupancy
    // (last API prompt_tokens + tail estimate), provider-agnostic.
    getEstimatedTokens: () => agent.session.getRealOccupancy(),
    getContextWindow: () => spec.model.contextWindow,
    getReasoningEffort: () => agent.getReasoningEffort(),
    // Wave L: 进程退出释放本 session 的 coordinator timer + in-flight worker
    // 句柄。abort() 仅中止当前 turn；shutdown() 是终结性操作。
    shutdown: () => {
      try { void agent.cancelIdleCompaction() } catch { /* best-effort */ }
      try { stores.refs.coordinator?.shutdown() } catch { /* best-effort */ }
    },
    // I1: 桌面端议事会入口，直接评审 artifact 中的 council-plan-json。
    conveneCouncil: (input) => conveneCouncilOnCoordinator(agent, stores.refs.coordinator, stores.refs, input),
    // 用户主动派后台子代理：独立 AbortSignal，跑在隔离子会话，不碰主历史。
    delegateWorker: (input, opts) => delegateWorkerOnCoordinator(stores.refs.coordinator, input, opts),
  }
}

class CouncilError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message)
    this.name = 'CouncilError'
  }
}

/**
 * I1: 在指定 session 上召集议事会。输入 artifactId 必须指向一个包含
 * ```council-plan-json 代码块的可执行计划；后端从 raw 中提取 UnifiedPlan
 * 作为 draftItems。并发安全：agent 正在跑 turn 时直接拒绝。
 */
async function conveneCouncilOnCoordinator(
  agent: AgentLoop,
  coordinator: import('../agent/coordinator.js').DelegationCoordinator | null,
  refs: RuntimeRefs,
  input: {
    artifactId: string
    objective?: string
    seats?: { authority: string; charter?: string }[]
    rounds?: number
  },
): Promise<{ planMarkdown: string; artifactId: string }> {
  if (agent.isRunning()) {
    throw new CouncilError('Session is already running a turn', 409)
  }
  if (!coordinator) {
    throw new Error('DelegationCoordinator not initialized')
  }
  const raw = await agent.artifactStore?.readRaw(input.artifactId)
  if (!raw) {
    throw new CouncilError('Artifact not found', 404)
  }
  const planJson = extractCouncilPlanJson(raw)
  if (!planJson) {
    throw new CouncilError('Artifact does not contain a valid council-plan-json block', 400)
  }
  const draftItems: PlanItem[] = planJson.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    detail: t.objective,
    files: t.files,
  }))
  const seats: CouncilSeat[] = input.seats && input.seats.length > 0
    ? input.seats.map((s) => ({ authority: s.authority, ...(s.charter ? { charter: s.charter } : {}) }))
    : [...DEFAULT_COUNCIL_SEATS]
  const abortController = new AbortController()
  const councilInput: CouncilInput = {
    draft: { objective: input.objective ?? planJson.objective, items: draftItems },
    seats,
    abortSignal: abortController.signal,
    ...(typeof input.rounds === 'number' ? { maxRounds: input.rounds } : {}),
  }
  const now = Date.now()
  const deps = {
    delegateBatch: async (
      requests: import('../agent/council/council-orchestrator.js').CouncilFanoutRequest[],
      policy: 'all_required',
      signal?: AbortSignal,
      onProgress?: (completed: number, total: number) => void,
    ) => {
      const delegationReqs: import('../agent/coordinator.js').DelegationRequest[] = requests.map((r) => ({
        parentTurnId: r.parentTurnId,
        objective: r.objective,
        kind: r.kind,
        profile: r.profile,
        scope: r.scope,
      }))
      const run = await coordinator.delegateBatch(
        delegationReqs,
        policy,
        signal,
        onProgress,
      )
      return { results: run.results, workerModels: run.workerModels }
    },
    now: () => now,
    sessionId: refs.sessionId ?? 'unknown',
    recordRoutingShadow: (event: import('../agent/council/council-routing.js').CouncilRoutingShadowEvent) => persistCouncilRoutingShadow(refs.meridianIndexer?.getDb(), event),
  }
  const runner = councilInput.maxRounds && councilInput.maxRounds >= 2 ? runCouncilDebate : runCouncil
  const plan = await runner(councilInput, deps)
  const planMarkdown = renderCouncilPlan(plan)
  const outputRaw = plan.aggregate.mergedItems.length > 0
    ? [planMarkdown, '', '```council-plan-json', serializeUnifiedPlan(councilPlanToUnifiedPlan(plan)), '```'].join('\n')
    : planMarkdown
  const savedArtifactId = await agent.artifactStore?.save({
    tool: 'council_convene',
    target: `council:${plan.meta.objectiveHash}`,
    rawContent: outputRaw,
    summary: summarizeCouncilPlan(plan),
    sections: [],
  })
  try {
    recordCouncilSession(refs.meridianIndexer?.getDb(), {
      schemaVersion: 1,
      sessionId: refs.sessionId ?? 'unknown',
      objective: plan.objective,
      objectiveHash: plan.meta.objectiveHash,
      seats: plan.seats,
      roundsRun: plan.meta.round,
      decisionCount: plan.aggregate.decisions.length,
      acceptedCount: plan.aggregate.decisions.filter((d) => d.verdict === 'accepted').length,
      rejectedCount: plan.aggregate.decisions.filter((d) => d.verdict === 'rejected').length,
      deferredCount: plan.aggregate.decisions.filter((d) => d.verdict === 'deferred').length,
      conflictCount: plan.aggregate.conflicts.length,
      mergedItemCount: plan.aggregate.mergedItems.length,
      convenedAt: plan.meta.convenedAt,
      timestamp: Date.now(),
    })
  } catch {
    // 遥测失败不影响交付
  }
  if (!savedArtifactId) {
    throw new Error('Failed to save council plan artifact')
  }
  return { planMarkdown, artifactId: savedArtifactId }
}

function extractCouncilPlanJson(raw: string): UnifiedPlan | null {
  const match = raw.match(/```council-plan-json\n([\s\S]*?)\n```/)
  if (!match) return null
  return deserializeUnifiedPlan(match[1]!)
}

/** Map a friendly profile to a work-order kind so patch/review/verify workers
 *  get the right execution mode (mirrors delegate_task's kind semantics). */
function kindForProfile(profile: string): import('../agent/coordinator.js').DelegationRequest['kind'] {
  switch (profile) {
    case 'patcher': return 'patch_proposal'
    case 'reviewer': return 'review'
    case 'verifier':
    case 'adversarial_verifier': return 'verify'
    case 'planner':
    case 'perspective_planner': return 'plan'
    case 'doc_scout': return 'doc_research'
    default: return 'code_search'
  }
}

/** Build the terminal digest shown in the panel + adopted into the composer by
 *  the "汇入主会话" button. Markdown: objective + outcome + changed files +
 *  worker summary (truncated). Pure — easy to unit test. */
export function buildDelegateSummary(
  input: { objective: string },
  run: import('../agent/coordinator.js').CoordinatorRun,
): string {
  const result = run.results[0]
  const statusLabel = result?.status === 'passed' ? '完成'
    : result?.status === 'blocked' ? '受阻'
    : result?.status === 'escalated' ? '已升级'
    : result?.status === 'failed' ? '失败'
    : run.status === 'skipped' ? '已跳过' : '完成'
  const lines: string[] = []
  lines.push(`子代理任务「${input.objective}」${statusLabel}。`)
  const changed = result?.changedFiles ?? []
  if (changed.length > 0) {
    lines.push('', '变更文件：')
    for (const f of changed.slice(0, 20)) lines.push(`- ${f}`)
    if (changed.length > 20) lines.push(`- …其余 ${changed.length - 20} 个`)
  }
  if (result?.summary) {
    lines.push('', '子代理总结：', result.summary.slice(0, 1200))
  }
  lines.push('', '请审查以上结果，确认无误后继续。')
  return lines.join('\n')
}

/** User-dispatched background subagent runner. Mirrors delegate_task's request
 *  shaping but bridges activity to a plain callback (no tool pipeline) and
 *  produces a terminal summary for the adopt-to-composer flow. */
async function delegateWorkerOnCoordinator(
  coordinator: import('../agent/coordinator.js').DelegationCoordinator | null,
  input: DelegateWorkerInput,
  opts: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void },
): Promise<void> {
  if (!coordinator) throw new Error('DelegationCoordinator not initialized')
  const profile = input.profile && input.profile.trim() ? input.profile.trim() : 'code_scout'
  const request: import('../agent/coordinator.js').DelegationRequest = {
    // Use the manager-owned workerId as the stable node key (parentTurnId derives
    // the work order id), so every activity update merges into the same panel node.
    parentTurnId: opts.workerId,
    objective: input.objective,
    kind: kindForProfile(profile),
    profile: profile as import('../agent/work-order.js').WorkerProfile,
    scope: input.files && input.files.length ? { files: input.files } : {},
    delegationDepth: 0,
    onActivity: (ev) => {
      opts.onActivity({
        workOrderId: opts.workerId,
        profile: ev.profile ?? profile,
        authority: ev.authority,
        status: 'running',
        progressLine: activityProgressLine(ev),
      })
    },
  }
  if (input.authority) request.authority = input.authority
  const run = await coordinator.delegate(request, opts.signal)
  const result = run.results[0]
  const status: DelegateActivityUpdate['status'] = result?.status ?? (run.status === 'skipped' ? 'blocked' : 'passed')
  opts.onActivity({
    workOrderId: opts.workerId,
    profile,
    status,
    progressLine: result?.summary ? result.summary.slice(0, 120) : undefined,
    summary: buildDelegateSummary(input, run),
    changedFiles: result?.changedFiles && result.changedFiles.length > 0 ? result.changedFiles : undefined,
    artifactId: result?.diffArtifactId,
    model: run.selectedModel ?? result?.model,
    provider: result?.provider,
    usage: result?.usage,
  })
}

export interface RunServeOptions {
  port?: number
  token?: string
  /** Override the serve context (tests inject a fake). */
  context?: ServeContext
  /** Directory for durable desktop session storage. Defaults to ~/.rivet/desktop/sessions. */
  sessionDir?: string
  /** Disable persistence (tests / ephemeral). */
  ephemeral?: boolean
  /**
   * R1 — shared cross-session registry (file claims / OwnershipGuard / conflict
   * blocking). Tests inject a pre-built one; production creates it async at boot.
   * When absent, concurrency features stay dormant and behavior is unchanged.
   */
  sessionRegistry?: SessionRegistry
}

export interface RunningServer {
  port: number
  close: () => void
  sessions: RuntimeSessionManager
  scheduler?: CronScheduler
  /** Shared runtime for the exit handler to access mcpManager. */
  shared: SharedRuntime
}

/**
 * Start the runtime API server. Returns the bound port, a close() that aborts
 * all in-flight work, and the RuntimeSessionManager backing the multi-session
 * API. Throws if no token is available (fail-closed).
 */
export function runServe(opts: RunServeOptions = {}): RunningServer {
  const apiToken = (opts.token ?? process.env.RIVET_SERVER_TOKEN)?.trim()
  if (!apiToken) {
    throw new Error('RIVET_SERVER_TOKEN is required for rivet serve')
  }
  const port = opts.port ?? 3100
  const ctx = opts.context ?? resolveServeContext()
  const startedAt = Date.now()

  // R1 — one shared SessionRegistry for the whole sidecar. Created async (the
  // SQLite backend dynamic-imports better-sqlite3); sessions are created
  // seconds later by user interaction, by which time it's resolved. Tests pass a
  // pre-built registry. Ephemeral mode (tests) skips it → behavior unchanged.
  let sessionRegistry: SessionRegistry | undefined = opts.sessionRegistry
  if (!sessionRegistry && !opts.ephemeral) {
    const registryDir = desktopDir()
    void SessionRegistry.create(registryDir)
      .then((r) => { sessionRegistry = r })
      .catch((err) => {
        // Registry init failed (e.g. better-sqlite3 native build missing).
        // Concurrency features stay dormant; surface the cause instead of
        // silently swallowing it so the failure is diagnosable in logs.
        console.error('[serve] SessionRegistry unavailable:', (err as Error)?.message ?? err)
      })
  }

  // N1: durable session storage so sessions survive sidecar restarts.
  const persistence = opts.ephemeral
    ? undefined
    : new FileSessionPersistence(
        opts.sessionDir ?? desktopSessionsDir(),
      )

  // Wave J: sidecar 级 SharedRuntime——providerHealth 跨 session 共享让
  // health 统计累积；domainStores 按 cwd 缓存避免重复磁盘 load + 跨 session
  // lessons 可见。runServe 进程级单例，传给每个 buildManagedAgent。
  // Wave F: sameCwdRunningCount 是 late-bound——sessions 创建后才能引用，
  // 先置 null，sessions 就绪后回写。getSameCwdRunningSessions getter 对
  // sessions 未就绪的窗口期会回退 0（安全）。
  const sharedRuntime: SharedRuntime = {
    providerHealth: new ProviderHealthTracker(),
    domainStores: new Map(),
    sameCwdRunningCount: null,
    mcpManager: null,
    sessions: null,
  }

  // Initialize MCP manager asynchronously — connects to configured servers,
  // discovers tools, and registers them to the shared runtime. Fire-and-forget
  // so server startup isn't blocked on slow MCP servers.
  void (async () => {
    try {
      const mgr = new McpManager(ctx.config.mcp)
      await mgr.initialize()
      sharedRuntime.mcpManager = mgr
      serverLogger.warn(`MCP: ${mgr.getStates().filter(s => s.status === 'connected').length} servers connected, ${mgr.getAllTools().length} tools`)
    } catch (err) {
      serverLogger.warn('MCP initialization failed:', { error: (err as Error)?.message ?? String(err) })
    }
  })()

  // Multi-session manager (M0.5): each session is an independent AgentLoop,
  // adapted to the manager's ManagedAgent surface (run/abort + artifacts). The
  // manager's session id is threaded into buildAgentLoop so the agent's stores
  // align with the session.
  const sessions = new RuntimeSessionManager({
    createAgent: (cwd, sessionId, approvalMode) =>
      buildManagedAgent(ctx, cwd ?? process.cwd(), sessionId ?? randomUUID(), sessionRegistry, approvalMode, sharedRuntime),
    defaultCwd: process.cwd(),
    persistence,
    // R1 — late-bound getter: registry resolves async after server start.
    getSessionRegistry: () => sessionRegistry,
    // PlusMenu — provider model source + default for the model picker.
    // Reload-aware: picks up providers configured after startup (no restart).
    listModels: () => listAllModelsWithReload(ctx),
    defaultModelId: ctx.model.id,
  })

  // Wave F: sessions 现已就绪——把真实 sameCwdRunningCount 回写到 SharedRuntime。
  // 之后任何 buildManagedAgent → buildSessionStores 创建的 refs.getSameCwdRunningSessions
  // 都会读到这条真实值；verificationSnapshotManager 的多 session 冲突检测真正生效。
  sharedRuntime.sameCwdRunningCount = (cwd, excludeSessionId) =>
    sessions.sameCwdRunningCount(cwd, excludeSessionId)
  // I4: sessions 就绪后回写，让 user hooks 能把结果推送到桌面事件流。
  sharedRuntime.sessions = sessions

  // Legacy single-prompt path (M0): one-shot POST /prompt SSE.
  const activeAgents = new Set<AgentLoop>()
  let activeAgent: AgentLoop | null = null
  const state: ServerState = {
    running: false,
    apiToken,
    abort: () => {
      for (const agent of activeAgents) agent.abort()
      sessions.abortAll()
    },
  }

  const routes = createRoutes(state, {
    createAgent: () => {
      // Wave J: legacy /prompt 路径同样复用 sharedRuntime——避免与
      // /sessions/:id/prompt 路径间健康统计不一致。
      const { agent, sessionId } = buildAgentLoop(ctx, process.cwd(), undefined, undefined, undefined, sharedRuntime)
      activeAgents.add(agent)
      activeAgent = agent
      state.running = true
      state.sessionId = sessionId
      return {
        run: async (prompt, callbacks) => {
          try {
            await agent.run(prompt, callbacks)
          } finally {
            activeAgents.delete(agent)
            if (activeAgent === agent) activeAgent = activeAgents.values().next().value ?? null
            state.running = activeAgents.size > 0
            state.sessionId = activeAgent?.config.sessionId
          }
        },
        abort: () => agent.abort(),
      }
    },
  })

  // Multi-session routes (M0.5 → M3): /sessions/*. R3 rollback routes consult
  // the live registry to build an OwnershipGuard, so thread it in via getter.
  Object.assign(routes, buildSessionRoutes(sessions, apiToken, () => sessionRegistry, ctx.config))

  // Config routes: provider + API key management for the desktop settings UI.
  Object.assign(routes, buildConfigRoutes(apiToken))

  // Environment route: host toolchain availability (python, uv, git, node) for setup UI.
  Object.assign(routes, buildEnvRoute(apiToken))

  // Project templates route: first-run AGENTS.md / .rivet.md bootstrap for desktop UI.
  Object.assign(routes, buildProjectTemplatesRoutes(apiToken))

  // MCP routes: server management + live status for the desktop MCP settings UI.
  Object.assign(routes, buildMcpRoutes(() => sharedRuntime.mcpManager, apiToken))

  // Open file in system editor / reveal in file manager — thin wrapper so the
  // Desktop webview can request the sidecar to open a local path without
  // needing a Tauri plugin.
  routes['POST /open-file'] = (body) => {
    const filePath = (body as Record<string, unknown>)?.path
    if (typeof filePath !== 'string' || !filePath) {
      return { status: 400, body: { error: 'Missing path' } }
    }
    const reveal = (body as Record<string, unknown>)?.reveal === true
    import('node:child_process').then(({ spawn }) => {
      const command = reveal ? buildRevealCommand(filePath) : buildOpenPathCommand(filePath)
      const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.on('spawn', () => child.unref())
    })
    return { status: 200, body: { opened: filePath } }
  }

  // Open an external URL in the system browser. `start` is a cmd builtin (not an
  // exe), so on Windows it must be invoked via `cmd /c start "" <url>`; the empty
  // title arg keeps URLs parsed correctly. Used by the first-run Git install
  // dialog's "open download page" button.
  routes['POST /open-external'] = (body) => {
    const url = (body as Record<string, unknown>)?.url
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { status: 400, body: { error: 'Missing or invalid url (must be http/https)' } }
    }
    import('node:child_process').then(({ execFile }) => {
      if (process.platform === 'win32') {
        execFile('cmd', ['/c', 'start', '', url], () => {})
      } else {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
        execFile(opener, [url], () => {})
      }
    })
    return { status: 200, body: { opened: url } }
  }

  // N1: GET /health — sidecar liveness for the desktop crash-reconnect banner.
  const version = process.env.npm_package_version ?? '2.9.0'
  // registryOk lets the desktop tell "sidecar up but concurrency dormant" apart
  // from a healthy sidecar. In ephemeral/test mode (no registry wired) it reads
  // true so existing single-session behavior is unchanged.
  Object.assign(
    routes,
    buildHealthRoute(sessions, startedAt, version, apiToken, () =>
      opts.ephemeral ? true : sessionRegistry !== undefined,
    () => resolveServeContext().configured,
    ),
  )

  // N3: async orchestration — cron scheduler → task registry → runtime pool that
  // spins up *visible* sessions. Disabled in ephemeral mode (tests) to avoid
  // leaking timers.
  let scheduler: CronScheduler | undefined
  let wiring: CronWiring | undefined
  let taskRegistry: TaskRegistry | undefined
  if (!opts.ephemeral) {
    const rivetDir = desktopDir()
    scheduler = new CronScheduler({ schedulePath: join(rivetDir, 'scheduled_tasks.json') })
    const registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(rivetDir, 'tasks')) })
    taskRegistry = registry
    const runtimePool = new SessionRuntimePool({ manager: sessions, defaultCwd: process.cwd() })
    // CronLock: with multiple sidecars pointed at the same desktop dir, exactly
    // one wins the lock and runs the scheduler — the rest stay idle instead of
    // double-firing every scheduled task.
    const lock = new CronLock({ lockPath: join(rivetDir, 'scheduled_tasks.lock') })
    wiring = new CronWiring({ scheduler, registry, runtimePool, lock })
    void wiring.start().catch(() => { /* non-fatal: scheduler stays idle */ })
    Object.assign(routes, buildScheduleRoutes(scheduler, apiToken, () => wiring?.getStatus()))
    // Task audit/history API (execution records for the automations dashboard).
    // The scheduler + task-registry share this desktop dir, so events land in
    // .rivet/tasks/events alongside the task records.
    Object.assign(routes, buildTaskRoutes({
      registry,
      apiToken,
      notifyPolicy: 'state_changes',
      eventsDir: join(rivetDir, 'tasks', 'events'),
    }))
  }

  const server = startServer(port, routes, apiToken)
  return {
    port,
    sessions,
    scheduler,
    shared: sharedRuntime,
    close: () => {
      for (const agent of activeAgents) agent.abort()
      sessions.abortAll()
      // Wave L: 与 TUI createShutdownHandler 对称——abort 中止 turn 后，对所有
      // session 显式 shutdown 释放 coordinator stallSweep + 在途 worker 句柄。
      // 进程退出 OS 会回收，但显式 shutdown 语义清晰、对齐双侧路径。
      sessions.shutdownAll()
      void wiring?.stop()
      wiring?.dispose()
      taskRegistry?.dispose()
      scheduler?.stop()
      // Kill MCP child processes synchronously — async shutdown() may not
      // complete before the process exits, leaving orphaned subprocesses.
      sharedRuntime.mcpManager?.killChildrenSync()
      server.close()
    },
  }
}

export interface ParentWatchdogOptions {
  /** Probe interval. Default 3000ms. */
  intervalMs?: number
  /** Consecutive failed probes required before onParentGone fires. Default 3. */
  maxMisses?: number
  /** Injectable liveness probe (tests). Returns true when the parent is alive. */
  probe?: (ppid: number) => boolean
}

/** True when `ppid` still exists (signal-0 probe; EPERM = alive but not ours). */
export function probeParentAlive(ppid: number): boolean {
  try {
    // signal 0 probes existence/permission without actually signalling.
    process.kill(ppid, 0)
    return true
  } catch (err) {
    // ESRCH = parent gone. EPERM = alive but not ours → still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Parent-death watchdog. The desktop shell spawns the sidecar with
 * `RIVET_PARENT_PID` set to its own pid; we poll whether that process still
 * exists and self-terminate when it's gone. This is the cross-platform backstop
 * for the case the shell's `Child::kill()` can't cover — a crash, a SIGKILL, or
 * Windows "End task" — which would otherwise leave an orphaned `node.exe`
 * holding the port. No-op when the env var is absent (manual `rivet serve`).
 *
 * 宽限：单次探测失败可能是瞬时误报（父进程短暂无响应、电源状态切换等），
 * 立即自杀会造成「sidecar 半夜无故死亡」。改为连续 maxMisses 次（默认 3 次
 * ≈ 9s）失败才触发退出，期间任一次成功即清零；每次 miss 记日志留现场。
 */
export function installParentWatchdog(
  onParentGone: (info: { ppid: number; misses: number }) => void,
  options: ParentWatchdogOptions = {},
): void {
  const raw = process.env.RIVET_PARENT_PID
  const ppid = raw ? Number(raw) : NaN
  if (!Number.isInteger(ppid) || ppid <= 0) return
  const intervalMs = options.intervalMs ?? 3000
  const maxMisses = options.maxMisses ?? 3
  const probe = options.probe ?? probeParentAlive
  let misses = 0
  let fired = false
  const timer = setInterval(() => {
    if (fired) return
    if (probe(ppid)) {
      misses = 0
      return
    }
    misses++
    if (misses < maxMisses) {
      console.error(`[serve] parent pid ${ppid} probe miss ${misses}/${maxMisses} — exiting after ${maxMisses} consecutive misses`)
      return
    }
    // fired guard: shutdown (process.exit) may take a beat; the interval must
    // not re-enter onParentGone in the meantime.
    fired = true
    clearInterval(timer)
    onParentGone({ ppid, misses })
  }, intervalMs)
  // Don't let the watchdog itself keep the event loop alive — the HTTP server
  // already does, and an unref'd timer won't block a clean exit.
  timer.unref()
}

/**
 * Best-effort exit-reason breadcrumb. OOM / hard kills can't write anything, so
 * the PRESENCE of this file distinguishes a deliberate self-shutdown (watchdog,
 * signal) from a silent death — the exact ambiguity that made the "sidecar died
 * overnight" incidents unattributable. Written to the desktop dir next to the
 * scheduler artifacts; failures are swallowed.
 */
function writeExitBreadcrumb(reason: string, extra: Record<string, unknown> = {}): void {
  try {
    const path = join(desktopDir(), 'sidecar-exit.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      reason,
      pid: process.pid,
      at: new Date().toISOString(),
      ...extra,
    }, null, 2))
  } catch {
    // best-effort — never block shutdown on breadcrumb IO
  }
}

/**
 * CLI command handler for `rivet serve [--port N]`. Wires signal handlers and
 * prints the listening banner. Exits non-zero on misconfiguration.
 */
export function serveCommand(args: string[]): void {
  const portIdx = args.indexOf('--port')
  const port = parseInt(portIdx >= 0 ? args[portIdx + 1]! : '3100', 10)

  let server: RunningServer
  try {
    server = runServe({ port })
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  const shutdownServer = () => {
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => {
    writeExitBreadcrumb('signal', { signal: 'SIGINT' })
    shutdownServer()
  })
  process.on('SIGTERM', () => {
    writeExitBreadcrumb('signal', { signal: 'SIGTERM' })
    shutdownServer()
  })
  installParentWatchdog(({ ppid, misses }) => {
    console.error(`[serve] parent process gone (pid ${ppid}, ${misses} consecutive probe misses) — shutting down sidecar`)
    writeExitBreadcrumb('parent-gone', { ppid, misses })
    shutdownServer()
  })

  // Last-resort: SIGKILL MCP children even if shutdownServer threw.
  process.on('exit', () => {
    try { server.shared.mcpManager?.killChildrenSync?.() } catch { /* best-effort */ }
  })

  console.log(`Rivet Runtime API listening on http://localhost:${port}`)
  console.log('Endpoints: GET /status, POST /abort, POST /prompt, /sessions/*')
}
