/**
 * Heavy agent assembly for `rivet serve` — loaded via dynamic import after the
 * HTTP listener is up (or on first session), so /health cold-start does not pay
 * for AgentLoop / tools / Meridian / council / MCP SDK graph.
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { activityProgressLine } from '../tools/worker-activity-stream.js'
import type { DelegateWorkerInput, DelegateActivityUpdate, ManagedAgent, RuntimeSessionManager } from './session-manager.js'
import { SessionPersist } from '../agent/session-persist.js'
import { FileHistory } from '../agent/file-history.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
import { AgentLoop } from '../agent/loop.js'
import type { ApprovalMode } from '../agent/loop-types.js'
import { SessionContext } from '../agent/context.js'
import type { SessionRegistry } from '../agent/session-registry.js'
import { createTaskLedger } from '../agent/task-ledger.js'
import { createOwnershipLedger } from '../agent/ownership-ledger.js'
import { createWorktreeBaseline } from '../agent/worktree-baseline.js'
import { captureGitBaseline, createInteractiveToolRegistry, createAgentRuntime, type RuntimeRefs } from '../bootstrap.js'
import { TodoStore } from '../tools/todo-store.js'
import { applyConfiguredPathGrants, loadPersistedGrants } from '../tools/path-grants.js'
import { loadProjectSkills } from '../skills/skill-loader.js'
import { createMemoryTool } from '../tools/memory.js'
import { DomainKnowledgeStore } from '../agent/domain-knowledge-store.js'
import type { ProviderHealthTracker } from '../agent/provider-health.js'
import { MeridianIndexer } from '../repo/meridian-indexer.js'
import { resetLegacyMemoryIfNeeded } from '../agent/memory-epoch.js'
import { createMultiLspManager } from '../lsp/multi-manager.js'
import type { LspManager } from '../lsp/manager.js'
import { createGotoDefinitionTool, createFindReferencesTool } from '../lsp/tools.js'
import { runCouncil, runCouncilDebate, type CouncilInput } from '../agent/council/council-orchestrator.js'
import type { CouncilSeat } from '../agent/council/council-routing.js'
import { renderCouncilPlan, summarizeCouncilPlan } from '../agent/council/council-render.js'
import { DEFAULT_COUNCIL_SEATS } from '../agent/council/council-routing.js'
import { councilPlanToUnifiedPlan } from '../agent/council/council-to-plan.js'
import { serializeUnifiedPlan, deserializeUnifiedPlan, type UnifiedPlan } from '../agent/unified-plan.js'
import { recordCouncilSession } from '../agent/council/council-telemetry.js'
import { persistCouncilRoutingShadow } from '../agent/council/council-routing.js'
import type { PlanItem } from '../agent/council/council-plan.js'
import type { McpManager } from '../mcp/manager.js'
import {
  type ServeContext,
  type ResolvedModelSpec,
  type HistoryRestoreInfo,
  resolveServeContext,
  resolveModelSpec,
  resolveModelSpecWithReload,
  isModelSpecUsable,
  unconfiguredSpecMessage,
  restoreHistoryMessages,
  buildDelegateSummary,
} from './serve.js'

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
  // per-cwd 资源统一用 Map<string, X> 模式（镜像 domainStores），防模式漂移。
  domainStores: Map<string, DomainKnowledgeStore>
  /** per-cwd MeridianIndexer——SQLite 单写者，同 cwd 多 session 必须共享单实例。 */
  meridianIndexers: Map<string, MeridianIndexer>
  /** per-cwd LSP 管理器——语言服务器子进程池，重复 spawn 浪费且互踩。
   *  entry.ready 是 initialize() 的完成 Promise（true=至少一个 server 可用）；
   *  每次 assembleAgentLoop 都对它订阅 .then 以捕获当次 agent（switchModel 安全）。 */
  lspManagers: Map<string, { manager: LspManager; ready: Promise<boolean> }>
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

/** 按 cwd 取/建 MeridianIndexer（镜像 getOrCreateDomainStore）。SQLite 单写者，
 *  同 cwd 多 session 共享同一实例；runServe close() 统一释放。exported for tests. */
export function getOrCreateMeridianIndexer(shared: SharedRuntime, cwd: string): MeridianIndexer {
  const existing = shared.meridianIndexers.get(cwd)
  if (existing) return existing
  const indexer = new MeridianIndexer(cwd)
  // Memory epoch reset（镜像 TUI bootstrapInteractiveSession）——桌面端会话
  // 首次触达某 cwd 时清空中毒的跨会话学习存量，见 memory-epoch.ts。
  try {
    resetLegacyMemoryIfNeeded(cwd, {
      clearMistakeEntries: () => indexer.getDb().clearMistakeEntries(),
    })
  } catch { /* 清理绝不阻塞会话创建 */ }
  shared.meridianIndexers.set(cwd, indexer)
  return indexer
}

/** 按 cwd 取/建 LSP manager entry。首个触达某 cwd 的会话触发 initialize()
 *  （异步，不阻塞会话创建）；后续会话复用同一 entry。ready resolve 为
 *  isReady()——false 表示该 cwd 没有可用的语言服务器（工具不注册）。 */
function getOrCreateLspEntry(
  shared: SharedRuntime,
  cwd: string,
): { manager: LspManager; ready: Promise<boolean> } {
  const existing = shared.lspManagers.get(cwd)
  if (existing) return existing
  const manager = createMultiLspManager(cwd)
  const ready = manager
    .initialize()
    .then(() => manager.isReady())
    .catch(() => false)
  const entry = { manager, ready }
  shared.lspManagers.set(cwd, entry)
  return entry
}

/** Wave G: LSP late-init 订阅（照 TUI bootstrap.ts initializeLsp 的 .then 语义）。
 *  设计约束（switchModel 安全性）：每次 assembleAgentLoop 调用时挂载——捕获
 *  当次的新 agent。Promise 已 resolve 时晚订阅立即触发，所以 switchModel
 *  重建的 agent 照样收到 updateTools()；重复 register 无害（ToolRegistry.register
 *  是 Map.set 幂等覆盖）。老 agent 的旧回调对废弃对象空刷一次，无害。
 *  exported for tests（注入 mock entry，不真实 spawn 语言服务器）。 */
export function attachLspTools(
  entry: { manager: LspManager; ready: Promise<boolean> },
  toolRegistry: Pick<ReturnType<typeof createDefaultToolRegistry>, 'register'>,
  refs: Pick<RuntimeRefs, 'lspManager'>,
  updateTools: () => void,
): Promise<void> {
  return entry.ready.then((ok) => {
    if (!ok) return
    toolRegistry.register(createGotoDefinitionTool(entry.manager))
    toolRegistry.register(createFindReferencesTool(entry.manager))
    refs.lspManager = entry.manager
    updateTools()
  })
}

/** Wave G: 释放 per-cwd 共享资源（runServe close()）。每个调用 try-catch
 *  包裹（防御习惯；MeridianDb.close 本身幂等，LspManager.dispose 内部已
 *  best-effort）。exported for tests. */
export function disposeSharedCwdResources(shared: SharedRuntime): void {
  for (const indexer of shared.meridianIndexers.values()) {
    try { indexer.close() } catch { /* best-effort */ }
  }
  shared.meridianIndexers.clear()
  for (const entry of shared.lspManagers.values()) {
    try { entry.manager.dispose() } catch { /* best-effort */ }
  }
  shared.lspManagers.clear()
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
  /** Outcome of the boot-time history restore — lets the session layer warn
   *  when the UI shows history but the model context came back empty. */
  historyRestore: HistoryRestoreInfo
  /** RuntimeRefs 在 createInteractiveToolRegistry 中被工具体内闭包持有；
   *  Wave C: assembleAgentLoop 通过 createAgentRuntime 装配 coordinator 后
   *  回写 refs.coordinator，让 5 个 coordinator 依赖工具激活。 */
  refs: RuntimeRefs
}

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
  // Path grants: hydrate the "remember"-persisted grants for this workspace and
  // apply standing config-declared grants (additionalReadDirs/WriteDirs). The
  // TUI does this in bootstrapInteractiveSession; without the mirror here,
  // desktop sessions silently lose every remembered/configured authorization
  // and re-block out-of-workspace paths (a major Windows papercut when the
  // project lives outside the opened folder).
  loadPersistedGrants(cwd)
  applyConfiguredPathGrants(ctx.config.agent.permissions)
  // Load skills into the shared registry (same as CLI bootstrap). Without this,
  // skillRegistry.list() returns empty and the desktop PlusMenu shows no skills.
  loadProjectSkills(cwd, { importFromClaude: ctx.config.skills?.importFromClaude })
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const session = new SessionContext()
  // Restore prior conversation from disk (sidecar restart recovery).
  // Matches TUI bootstrap.ts:1461 — loadOai returns [] for new sessions.
  const historyRestore = restoreHistoryMessages(persist, session)

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
    // Wave G: per-cwd 共享 Meridian——repo_graph/related_tests 惰性读 refs，
    // 但在 createInteractiveToolRegistry 之前设值（代码清晰）。legacy /prompt
    // 路径（无 shared）保持 null。
    meridianIndexer: shared ? getOrCreateMeridianIndexer(shared, cwd) : null,
    // 对称性回写：sidecar 无功能性消费者（服务器级 MCP 走 SharedRuntime），
    // 但避免 refs 硬编码 null 造成读到假状态。
    mcpManager: shared?.mcpManager ?? null,
    // Wave G: LSP 是异步 init——assembleAgentLoop 在 entry.ready 后回写。
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

  return { persist, claimStore, fileHistory, toolRegistry, session, taskLedger, ownershipLedger, refs, historyRestore }
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
  if (approvalMode) {
    agent.setApprovalMode(approvalMode)
    // 自治级别（dangerously-skip-permissions）联动无限轮次：真正全自动。
    if (approvalMode === 'dangerously-skip-permissions') {
      agent.config.maxTurns = 0
    }
  }

  // Wave G: LSP late-init——per-assemble 订阅（见 attachLspTools 的设计约束注释）。
  // 不阻塞会话创建（LSP spawn 可能秒级）。
  if (shared) {
    void attachLspTools(
      getOrCreateLspEntry(shared, cwd),
      stores.toolRegistry,
      stores.refs,
      () => agent.updateTools(),
    )
  }

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
/** A resolved spec can actually authenticate when it carries either an inline
 *  API key or an OAuth provider. After a sidecar crash-restart, a provider that
 *  relies on `apiKeyEnv` whose variable is not present in the respawned process
 *  resolves to apiKey='' — running against it produces a raw upstream 401. */
function specOfContext(ctx: ServeContext): ResolvedModelSpec {
  return {
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    model: { id: ctx.model.id, maxTokens: ctx.model.maxTokens, contextWindow: ctx.model.contextWindow, reasoningEffort: ctx.model.reasoningEffort },
  }
}

/**
 * Resolve the spec a new session starts on. When `reload` is provided (the
 * production sidecar path), prefer a fresh on-disk read so a key rotated via
 * desktop Settings takes effect for the next session WITHOUT a sidecar restart
 * — the startup snapshot's key may be stale or revoked. Tests that inject a
 * synthetic context pass no `reload` and keep the deterministic snapshot.
 */
function resolveInitialSpec(ctx: ServeContext, reload?: () => ServeContext): ResolvedModelSpec {
  if (reload) {
    try {
      const fresh = reload()
      if (fresh.configured) return specOfContext(fresh)
    } catch { /* mid-edit / broken config on disk — fall back to the snapshot */ }
  }
  if (ctx.configured) return specOfContext(ctx)
  // Re-read config — the user may have called POST /config/providers since startup.
  return specOfContext(resolveServeContext())
}

export function buildAgentLoop(
  ctx: ServeContext,
  cwd: string,
  sessionId: string = randomUUID(),
  registry?: SessionRegistry,
  approvalMode?: ApprovalMode,
  shared?: SharedRuntime,
  reload?: () => ServeContext,
): BuiltAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId, registry, shared)
  const spec = resolveInitialSpec(ctx, reload)
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
export function buildManagedAgent(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  registry: SessionRegistry | undefined,
  approvalMode: ApprovalMode | undefined,
  shared?: SharedRuntime,
  reload?: () => ServeContext,
  preferredModelId?: string,
): import('./session-manager.js').ManagedAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId, registry, shared)
  // Model affinity: a rehydrated session carries the model its prefix cache
  // was built on (record.model → preferredModelId). Build directly on it so a
  // resumed conversation never silently lands on the default model. Falls back
  // to the default only when the preferred id no longer resolves — resumeRun()
  // gates that case fail-closed before it ever reaches a run.
  let spec: ResolvedModelSpec =
    (preferredModelId
      ? reload
        ? resolveModelSpecWithReload(ctx, preferredModelId, reload)
        : resolveModelSpecWithReload(ctx, preferredModelId)
      : null) ?? resolveInitialSpec(ctx, reload)
  let agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry, shared)
  // Rebuild the loop on a new spec, preserving conversation + stores. Shared
  // by switchModel and the run pre-flight self-heal below.
  const rebuildOnSpec = (next: ResolvedModelSpec) => {
    const oldCoordinator = stores.refs.coordinator
    const oldAgent = agent
    void oldAgent.cancelIdleCompaction()
    spec = next
    const liveApprovalMode = oldAgent.config.approvalMode
    agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, liveApprovalMode, registry, shared)
    if (oldCoordinator && oldCoordinator !== stores.refs.coordinator) {
      try { oldCoordinator.shutdown() } catch { /* best-effort: shutdown is fail-open */ }
    }
    return oldAgent
  }
  return {
    run: (prompt, callbacks, images) => {
      // Auth pre-flight: if this session's model has no usable key (e.g. an
      // apiKeyEnv provider after a sidecar restart lost its env), fail with a
      // clear, actionable message instead of sending the request and surfacing
      // an opaque upstream 401. Rejecting routes through the manager's error
      // path (append 'error' event + status=failed).
      if (!isModelSpecUsable(spec)) {
        // Self-heal first: the key may have been configured or rotated via
        // Settings AFTER this agent was built. Re-resolve the same model
        // against the live config and rebuild in place — the session then
        // just works instead of demanding a sidecar restart.
        const healed = reload ? resolveModelSpecWithReload(ctx, spec.model.id, reload) : null
        if (healed && isModelSpecUsable(healed)) {
          rebuildOnSpec(healed)
        } else {
          return Promise.reject(new Error(unconfiguredSpecMessage(spec)))
        }
      }
      return agent.run(prompt, callbacks, images)
    },
    abort: () => agent.abort(),
    setApprovalMode: (mode) => {
      agent.setApprovalMode(mode)
      // 自治联动无限轮次，非自治恢复默认 200
      agent.config.maxTurns = mode === 'dangerously-skip-permissions' ? 0 : 200
    },
    enterPlanMode: () => agent.enterPlanMode(),
    exitPlanMode: () => agent.exitPlanMode(),
    setActivePlan: (plan) => agent.setActivePlan(plan),
    listArtifacts: () => agent.artifactStore?.list() ?? [],
    readArtifact: (artifactId) => agent.artifactStore?.readRaw(artifactId) ?? Promise.resolve(null),
    getMessages: () => agent.session.getMessages(),
    getHistoryRestore: () => stores.historyRestore,
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
      // Audit: capture the outgoing model before the rebuild replaces it.
      // (rebuildOnSpec cancels the old loop's idle compaction — it shares this
      // SessionContext with the incoming loop — and preserves the live
      // approvalMode the user may have switched since session creation.)
      const oldAgent = rebuildOnSpec(next)
      let fromModel: string | undefined
      try { fromModel = oldAgent.config.promptEngine.getModel() } catch { /* idle/未初始化 */ }
      // 持久化切换（与 TUI bootstrap.switchAgentRuntime 同源）：metadata.model/
      // provider 反映当前模型，JSONL 落 model_switch 审计行——没有这两笔，
      // 桌面端换模型在会话日志里是隐形的。best-effort，不阻塞切换。
      try {
        stores.persist.updateMetadata({ model: spec.model.id, provider: spec.provider.name })
        stores.persist.appendModelSwitch({ from: fromModel, to: spec.model.id, provider: spec.provider.name })
      } catch { /* persistence is best-effort — never block a model switch */ }
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
    // P0-2: plan_task 成功后 onToolResult 通过此方法读取 TodoStore 发 todo_state SSE
    getTodos: () => stores.refs.todoStore.read(),
    // Hot-inject MCP tools discovered after this agent was built (mid-session
    // connector enable). register is Map.set-idempotent; updateTools refreshes
    // the prompt tool list the same way attachLspTools does for LSP tools.
    registerExternalTools: (tools) => {
      for (const tool of tools) {
        stores.toolRegistry.register(tool)
      }
      agent.updateTools()
    },
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

