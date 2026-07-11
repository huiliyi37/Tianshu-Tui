/**
 * bootstrap.ts — 共享初始化层，由 T9 ANSI 唯一生产入口 src/main.ts 调用。
 *
 * 纯异步函数，零 React 依赖。历史上同时服务过已退役的 Ink 入口
 * （main.tsx，已从仓库移除）与 main-ansi.ts；现仅 src/main.ts 使用。
 *
 * 架构：
 *   bootstrapInteractiveSession() → BootstrapContext
 *   └── src/main.ts 直接 await 调用，连接 AgentLoop 到 TuiApp（engine/app.ts）
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { join } from 'path'
import { randomUUID, createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'fs'
import { spawnSync, spawn } from 'child_process'

import type { Config, ProviderConfig } from './config/schema.js'
import type { AuthProvider } from './auth/types.js'
import type { BaselineSnapshot } from './agent/worktree-baseline.js'
import type { ModelCapabilityCard } from './model/capability.js'

import { loadConfig as loadLayeredConfig } from './config/manager.js'
import { isProFeatureEnabled } from './config/pro-license.js'
import { lastSessionPointerDir, rivetHome, stateDir } from './config/paths.js'
import { setTargetConventions, applyConfiguredGitBashPath } from './platform.js'
import { AgentLoop } from './agent/loop.js'
import { createAgentConfig, createMainAgentConfigInput } from './agent/create-agent-config.js'
import { SessionContext } from './agent/context.js'
import { SessionPersist, evictOldSessions, getSessionDir } from './agent/session-persist.js'
import { decideStartupSession, RESUME_FRESHNESS_MS } from './agent/session-recovery.js'
import { runResumePreflightOai } from './context/resume-preflight.js'
import { createWriteEvidenceProbe } from './context/write-evidence-probe.js'
import { FileHistory } from './agent/file-history.js'
import { PromptEngine } from './prompt/engine.js'
import { createDefaultToolRegistry } from './tools/default-registry.js'
import { BROWSER_DEBUG_TOOL } from './tools/browser-debug/tool.js'
import { defaultStore as defaultTodoStore } from './tools/todo.js'
import { TodoStore } from './tools/todo-store.js'
import { createDelegateTaskTool } from './tools/delegate-task.js'
import { createUndoTool } from './tools/undo.js'
import { maybeWarnNoSandbox } from './tools/sandbox-profile.js'
import { applyConfiguredPathGrants, loadPersistedGrants } from './tools/path-grants.js'
import { createDelegateBatchTool } from './tools/delegate-batch.js'
import { createTeamOrchestrateTool } from './tools/team-orchestrate.js'
import type { PlanExecutorDeps } from './agent/plan-executor.js'
import { runTypeCheck } from './lsp/client.js'
import { GATE_TSC_TIMEOUT_MS } from './agent/typecheck-gate.js'
import { createCouncilConveneTool } from './tools/council-convene.js'
import { needsTemplatesInit } from './bootstrap/project-templates.js'
import { debugLog } from './utils/debug.js'
import { persistCouncilRoutingShadow } from './agent/council/council-routing.js'
import { recordCouncilSession } from './agent/council/council-telemetry.js'
import { createRecallCapsuleTool } from './tools/recall-capsule.js'
import { createRecallGeneralTool } from './tools/recall-general.js'
import { createRecordGeneralFindingTool } from './tools/record-general-finding.js'
import { createDeliverTaskTool } from './agent/deliver-task.js'
import { createUpdateGoalTool } from './tools/update-goal.js'
import { createTaskLedger } from './agent/task-ledger.js'
import { createOwnershipLedger } from './agent/ownership-ledger.js'
import { createVerificationAttribution } from './agent/verification-attribution.js'
import { createDeliveryGateV2 } from './agent/delivery-gate-v2.js'
import { createWorktreeBaseline } from './agent/worktree-baseline.js'
import { createVerificationSnapshotManager, reapOrphanSnapshots, reapOrphanHandsWorktrees } from './agent/verification-snapshot-manager.js'
import { cleanupStaleHandsBranches } from './agent/worktree.js'
import { initializePlugins } from './plugins/plugin-loader.js'
import { createProviderClient, resolveApiKey } from './api/factory.js'
import { buildReviewOverrideState } from './agent/review-model-override.js'
import type { ResolvedReviewOverride } from './agent/review-model-override.js'
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
import { resetLegacyMemoryIfNeeded } from './agent/memory-epoch.js'
import { ASK_USER_QUESTION_TOOL } from './tools/ask-user-question.js'
import { createRepoGraphTool } from './tools/repo-graph.js'
import { createRelatedTestsTool } from './tools/related-tests.js'
import { SEMANTIC_SEARCH_TOOL } from './tools/semantic-search.js'
import { buildSearchBackends } from './tools/web-search.js'
import { buildFetchOptions } from './tools/web-fetch/build-options.js'
import { APPLY_PATCH_TOOL } from './tools/apply-patch.js'
import { createSessionVitalsTool } from './tools/session-vitals.js'
import { createPlanTaskTool } from './tools/plan-task.js'
import { createMemoryTool } from './tools/memory.js'
import { MeridianIndexer } from './repo/meridian-indexer.js'
import { detectProjectFingerprint } from './repo/project-fingerprint.js'
import { loadProjectRules } from './context/rules-loader.js'
import { loadProjectSkills } from './skills/skill-loader.js'
import { killAllSync } from './tools/process-tracker.js'
import { persistFileHistory } from './agent/file-history-persist.js'
import { cleanupOrphanedTmpFiles } from './fs-atomic.js'
import { cleanupOldArtifactSessions } from './artifact/store.js'
import { createLspManager } from './lsp/manager.js'
import { createMultiLspManager } from './lsp/multi-manager.js'
import { availableServers } from './lsp/server-registry.js'
import { createGotoDefinitionTool, createFindReferencesTool } from './lsp/tools.js'
import { createCoordinatorReviewDeps } from './agent/review-coordinator-deps.js'
import { persistTeamWaveTelemetry, type TeamWaveTelemetry } from './agent/team-wave-telemetry.js'
import { buildTeamSchedulerRewardEvent, persistTeamSchedulerReward, persistTeamSchedulerShadow, type TeamSchedulerShadowEvent } from './agent/team-scheduler-shadow.js'
import { persistGatedInfluenceAudit, type GatedInfluenceAuditEvent } from './agent/gated-influence-audit.js'
import { computeTeamWaveReward, deriveTeamWaveRewardInput } from './agent/team-reward.js'
import { teamSchedulerArmForParallelism } from './agent/team-scheduler-bandit.js'
import { recordTeamWaveRewardClosure } from './agent/reward-loop.js'

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
  /** VSW: session-scoped snapshot manager (in-place by default per §6 policy). */
  verificationSnapshotManager: import('./agent/verification-snapshot-manager.js').VerificationSnapshotManager | null
  /** Track 3: 权威交付门禁（v2）— badge 与收敛检测共用。 */
  deliveryGate: import('./agent/delivery-gate-v2.js').DeliveryGateV2 | null
  meridianIndexer: MeridianIndexer | null
  mcpManager: any | null
  lspManager: ReturnType<typeof createLspManager> | null
  /** T5: bandit promotion state for /status observability. */
  banditState: import('./server/routes.js').BanditStatusEntry[] | null
  /** Prompt engine ref for depth-layer queries at deliver-task time. */
  promptEngine: import('./prompt/engine.js').PromptEngine | null
  /**
   * Wave F: 当前 cwd 下其他活跃 session 数（不含自己）。给
   * verificationSnapshotManager 做多 session worktree 冲突检测。
   *
   * TUI 单 session 路径不设置，createInteractiveToolRegistry 回退到 `() => 0`
   * 保持原行为。sidecar 多 session 路径通过 SharedRuntime → manager.sameCwdRunningCount
   * 接入真实计数，让 VSW snapshot 决策（in-place vs worktree）真实可用。
   */
  getSameCwdRunningSessions?: () => number
  /** Mutable ref to the current GoalTracker. Set by slash-commands /goal,
   *  read by deliver_task B1Context for auto-review gating. */
  goalTrackerRef: { current: import('./agent/goal-tracker.js').GoalTracker | null }
  /** 层3 回归契约：当前主控任务契约 getter（agent 创建后回填）。
   *  deliver_task 用它取 regressionInventory / objective 做重构回归核验。 */
  getTaskContract?: () => import('./context/task-contract.js').TaskContract | undefined
  /** W1 回归防线：EvidenceTracker.impactedTests getter（agent 创建后回填）。
   *  deliver_task 用它做改动波及测试的验证归因（module_unverified）。 */
  getImpactedTests?: () => string[]
  /** W5 清醒认知闭环：session_vitals 数据源（agent 创建后回填）。
   *  模型写"系统状态"类结论前的取证入口，全部运行时内存态实测。 */
  getSessionVitals?: () => import('./tools/session-vitals.js').SessionVitalsData
  /** 多会话隔离：本会话独立的 todo 清单 store。后端所有读/写（todo 工具、plan_task
   *  回灌、turn-end 任务进度注入、todo-reminder 快照）统一走它。TUI 复用全局
   *  defaultStore（保持 setTodoSession/loadTodos 持久化与会话切换语义），server 每会话 new。
   *  缓存不变量：会话生命周期内复用同一实例，loop 重建时随 refs 复用，不可重 new。 */
  todoStore: TodoStore
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
  /** True when first-run template init is pending — TUI layer handles the
   *  AGENTS.md prompt. Set by needsTemplatesInit() during bootstrap. */
  templatesPendingAgents?: boolean
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
      preExistingDirty: dirty ? dirty.split(/\r?\n/) : [],
      preExistingUntracked: untracked ? untracked.split(/\r?\n/) : [],
      capturedAt: Date.now(),
    }
  } catch {
    return { branch: '', head: '', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }
  }
}

// ── Session ID ─────────────────────────────────────────────────

let _cachedSessionId: string | null = null
let _sessionWasResumed = false

/** True when the active session id was explicitly resumed (--continue / --resume [id]). */
export function wasSessionResumed(): boolean {
  return _sessionWasResumed
}

/** Per-cwd last-session pointer file (so `--continue` returns *this* project's
 *  session, never another project's). Hashed cwd mirrors the memory-store
 *  convention (sha256(cwd).slice(0,12)). */
function lastSessionPointerFile(cwd: string): string {
  const dir = lastSessionPointerDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(dir, `${hash}.txt`)
}

/**
 * Resolve the session id for this run. Default is a FRESH session — there is NO
 * implicit/crash auto-resume. We only return to a previous session when the
 * user explicitly asks:
 *   - RIVET_RESUME_ID=<full-id>  → resume that specific session (highest prio)
 *   - RIVET_RESUME=1             → resume the most recent session for this cwd
 * See `decideStartupSession` for the full contract. Resuming reuses the existing
 * startup path (`persist.loadOai()` + `replaceMessages()`) to rehydrate — the
 * resumed id becomes this run's session id = log id = pointer id.
 *
 * Escape hatches: RIVET_NEW_SESSION=1 forces fresh; RIVET_NO_AUTO_RESUME=1 is a
 * no-op for default startup (kept for back-compat) since fresh is already default.
 */
export function getOrCreateSessionId(): string {
  if (_cachedSessionId) return _cachedSessionId
  const cwd = process.cwd()
  const dir = rivetHome()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const pointerFile = lastSessionPointerFile(cwd)
  let lastSessionId: string | null = null
  try {
    if (existsSync(pointerFile)) lastSessionId = readFileSync(pointerFile, 'utf-8').trim() || null
  } catch { /* ignore */ }
  // One-time compatibility fallback to the legacy global pointer. The cwd gate
  // in decideStartupSession rejects it if it belongs to a different project.
  if (!lastSessionId) {
    try {
      const legacy = join(dir, 'session-id.txt')
      if (existsSync(legacy)) lastSessionId = readFileSync(legacy, 'utf-8').trim() || null
    } catch { /* ignore */ }
  }

  const decision = decideStartupSession({
    lastSessionId,
    now: Date.now(),
    freshnessMs: RESUME_FRESHNESS_MS,
    forceNew: process.env.RIVET_NEW_SESSION === '1',
    resume: process.env.RIVET_RESUME === '1',
    resumeSessionId: process.env.RIVET_RESUME_ID || undefined,
    disableAutoResume: process.env.RIVET_NO_AUTO_RESUME === '1',
    currentCwd: cwd,
    load: (id) => {
      try {
        const persist = new SessionPersist(id, cwd)
        const meta = persist.loadMetadata()
        return {
          hasContent: persist.loadOai().length > 0,
          status: meta?.status,
          updatedAt: meta?.updatedAt,
          cwd: meta?.cwd,
          cleanExit: meta?.cleanExit,
        }
      } catch {
        return null
      }
    },
  })

  const id = decision.sessionId ?? randomUUID()
  _sessionWasResumed = decision.resumed
  try { writeFileSync(pointerFile, id) } catch { /* ignore */ }
  _cachedSessionId = id
  return id
}

/**
 * Clean up stale worker session directories under ~/.rivet/sessions/<slug>/.
 * Worker sessions (worker-*) create per-session dirs here (pheromones.json,
 * sensorium.jsonl). Removes worker dirs older than STALE_THRESHOLD_MS to
 * avoid deleting dirs that might still be in use by a concurrent worker.
 */
export const WORKER_DIR_STALE_THRESHOLD_MS = 3_600_000 // 1 hour

export function cleanupStaleWorkerSessionDirs(cwd: string, thresholdMs = WORKER_DIR_STALE_THRESHOLD_MS): number {
  const sessionsDir = getSessionDir(cwd)
  if (!existsSync(sessionsDir)) return 0
  let cleaned = 0
  try {
    const entries = readdirSync(sessionsDir)
    for (const entry of entries) {
      if (!entry.startsWith('worker-')) continue
      const fullPath = join(sessionsDir, entry)
      try {
        const st = statSync(fullPath)
        if (!st.isDirectory()) continue
        const age = Date.now() - st.mtimeMs
        if (age > thresholdMs) {
          rmSync(fullPath, { recursive: true, force: true })
          cleaned++
        }
      } catch { /* best-effort — skip unreadable entries */ }
    }
  } catch { /* best-effort */ }
  return cleaned
}

// ── Tool Registry (with all tools registered) ──────────────────

export function createInteractiveToolRegistry(
  refs: RuntimeRefs,
  config: Config,
  cwd: string,
): { registry: ReturnType<typeof createDefaultToolRegistry> } {
  const reg = createDefaultToolRegistry([], {
    desktopTools: config.agent.desktopTools,
    todoStore: refs.todoStore,
    // Computer Use（桌面 GUI 自动化）：EXTENDED 层，注册≠主控可见（tool gating
    // 过滤），@Computer / /tools enable 挂载时才进主控视野。darwin/win32 + Pro gated。
    computerUse: (process.platform === 'darwin' || process.platform === 'win32') && process.env.RIVET_COMPUTER_USE !== '0',
    proEnabled: isProFeatureEnabled(config, 'computerUse'),
    // web_search 后端链（DDG 默认 / Brave / Tavily），按 config.search 顺序 fallback。
    searchBackends: buildSearchBackends(config),
    // web_fetch 配置注入（超时/大小上限/UA/正文抽取）
    fetchOptions: buildFetchOptions(config),
  })

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

  // Shared plan-execution kernel deps: team_orchestrate and plan_task(execute:true)
  // run the SAME closed loop through executePlan (dispatch + scope-health +
  // telemetry + reward/episode closure). plan_task opts out of the review gate
  // (its post-commit auto review covers the diff).
  const planExecutorDeps: PlanExecutorDeps = {
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
    getMeridianIndexer: () => refs.meridianIndexer,
    // 门禁预算（5 分钟）而非默认 2 分钟：这个 runner 喂 wave-gate 硬门禁，
    // 满载机器 tsc 超时曾被记成 passed 放行（2026-07-07）。
    getTypecheckRunner: () => (cwd: string) => runTypeCheck(cwd, '*', GATE_TSC_TIMEOUT_MS),
  }
  reg.register(createTeamOrchestrateTool(planExecutorDeps, {
    defaultMaxParallel: config.agent.maxTeamParallel,
    // Pro gate（双层模式）：桌面端由 Rust 验签后注入 RIVET_PRO=1；CLI 保持软 gate。
    teamMaxEnabled: isProFeatureEnabled(config, 'teamMax'),
  }))

  // council_convene — 单轮多星域会诊出计划（与 team_orchestrate 解耦，默认绝不派执行；
  // autoExecute 经 executor 走完整 executePlan 闭环，与 team_orchestrate 同路径）。
  reg.register(createCouncilConveneTool({
    delegateBatch: async (requests, policy, abortSignal, onProgress) => {
      if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
      return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
    },
    getSessionId: () => refs.sessionId ?? undefined,
    recordRoutingShadow: event => persistCouncilRoutingShadow(refs.meridianIndexer?.getDb(), event),
    recordCouncilSession: event => recordCouncilSession(refs.meridianIndexer?.getDb(), event),
    executor: planExecutorDeps,
  }, config.agent.council.seats.length > 0 ? config.agent.council.seats : undefined, {
    multiRoundEnabled: isProFeatureEnabled(config, 'councilMultiRound'),
  }))

  // recall_capsule
  reg.register(createRecallCapsuleTool(() => cwd))

  // 将星账本（B1/B2）：recall_general 读战绩，record_general_finding 追加战绩。
  // 胶囊 = 方法论基因，账本 = 跨会话战绩记忆。
  reg.register(createRecallGeneralTool(() => cwd))
  reg.register(createRecordGeneralFindingTool(() => cwd))

  // ask_user_question
  reg.register(ASK_USER_QUESTION_TOOL)

  // browser_debug — persistent browser for local frontend/backend联调 (CDP route).
  // EXTENDED tier (gated from 主控 by default; opt-in via /tools enable or delegate).
  // Shared here so both TUI and desktop sidecar get the same tool + data flow.
  reg.register(BROWSER_DEBUG_TOOL)

  // repo_graph
  reg.register(createRepoGraphTool(() => refs.meridianIndexer))

  // related_tests — override the no-indexer default with a meridian-aware factory
  reg.register(createRelatedTestsTool(() => refs.meridianIndexer))

  reg.register(SEMANTIC_SEARCH_TOOL)
  // APPLY_PATCH: EXTENDED layer — overlap with hash_edit covers >90% of
  // use cases; kept here (interactive) for edge cases (e.g. git-format patches).
  reg.register(APPLY_PATCH_TOOL)
  // W5 session_vitals: EXTENDED layer（interactive 装配，不占 kernel budget）。
  // 只读自查工具——模型写"系统状态"类结论前的取证入口（incident 20b9714e）。
  // 工具定义跟版本发布上车（新定义 = 前缀一次性 miss，绝不热更）。
  reg.register(createSessionVitalsTool(() => refs.getSessionVitals?.() ?? null))
  // web_search is now in the kernel default-registry (CORE layer).
  // Remove the interactive registration to avoid double-registration.
  // PLAN_MODE_ALLOWED_TOOLS already references web_search alongside recall.
  reg.register(createPlanTaskTool({
    getCoordinator: () => refs.coordinator,
    getExecutorDeps: () => planExecutorDeps,
    getSessionId: () => refs.sessionId ?? undefined,
    // 多会话隔离：plan_task 写本会话 store（TUI 即 defaultStore，行为不变）。
    writeTodos: todos => refs.todoStore.write(todos),
  }))

  // B1 deliver_task
  // sidecar 多 session 路径必须用 refs.sessionId（每个 session 独立装配），
  // 全局 getOrCreateSessionId 仅作 TUI 单 session 路径的兼容 fallback。
  const b1TaskLedger = createTaskLedger({ taskId: refs.sessionId ?? getOrCreateSessionId() })
  refs.taskLedger = b1TaskLedger
  const b1Baseline = createWorktreeBaseline(captureGitBaseline(cwd))
  const b1Ownership = createOwnershipLedger({
    baseline: b1Baseline,
    taskLedger: b1TaskLedger,
  })
  refs.ownershipLedger = b1Ownership
  // VSW: best-effort reap of worktrees left by dead sessions, then a session-scoped
  // manager. §6 policy keeps a single clean session in-place (head==='' → not a git
  // repo → in-place; no other sessions on this cwd in the CLI path → in-place),
  // so behavior is unchanged unless the baseline is dirty or RIVET_VSW=1 forces it.
  try { reapOrphanSnapshots({ baseCwd: cwd, currentSessionId: refs.sessionId ?? undefined }) } catch { /* best-effort */ }
  try { reapOrphanHandsWorktrees({ baseCwd: cwd, currentSessionId: refs.sessionId ?? undefined }) } catch { /* best-effort */ }
  try { cleanupStaleHandsBranches(cwd) } catch { /* best-effort */ }
  // C4: config-declared VSW mode. 'off' skips the manager entirely (pipeline
  // degrades to in-place); 'always' forces isolation; 'auto' = §6 matrix.
  // RIVET_VSW=1 keeps its historical force semantics on top of any mode.
  const vswMode = config.agent.verificationSnapshot
  const b1SnapshotManager = vswMode === 'off' ? null : createVerificationSnapshotManager({
    baseCwd: cwd,
    sessionId: refs.sessionId ?? getOrCreateSessionId(),
    baselineHead: b1Baseline.getHead() || undefined,
    isGitRepo: b1Baseline.getHead().length > 0,
    preExistingDirtyCount: b1Baseline.getExternalDirtyCount(),
    preExistingUntrackedCount: b1Baseline.getExternalUntrackedCount(),
    // C2: sameCwdRunningSessions fallback now queries SessionRegistry (cross-process,
    // registry.db in shared stateDir). Previously hardcoded () => 0 so VSW never
    // activated for multi-TUI scenarios. Sidecar-provided getSameCwdRunningSessions
    // still takes priority when available.
    sameCwdRunningSessions: refs.getSameCwdRunningSessions
      ?? (() => refs.sessionRegistry?.countSameCwdActive(cwd, refs.sessionId ?? '') ?? 0),
    forceSnapshot: process.env.RIVET_VSW === '1' || vswMode === 'always',
  })
  refs.verificationSnapshotManager = b1SnapshotManager
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
    getCurrentSnapshotRef: () => b1SnapshotManager?.currentSnapshotRef() ?? undefined,
    sessionRegistry: refs.sessionRegistry ?? undefined,
    sessionId: refs.sessionId ?? undefined,
    reviewDepth: params?.reviewDepth ?? 0,
    getDepthLayer: () => refs.promptEngine?.getTaskDepthLayer(),
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
    isGoalActive: () => refs.goalTrackerRef.current?.isActive() ?? false,
    isGoalAchieved: () => refs.goalTrackerRef.current?.isGoalAchieved() ?? false,
    getLastVerdict: () => refs.goalTrackerRef.current?.getLastVerdict() ?? null,
    reviewConfig: config.agent.review,
    meridianIndexer: refs.meridianIndexer,
    getTaskContract: () => refs.getTaskContract?.(),
    getImpactedTests: () => refs.getImpactedTests?.() ?? [],
  })))

  // update_goal — model-driven goal lifecycle control (paused/blocked/complete)
  reg.register(createUpdateGoalTool(
    () => refs.goalTrackerRef.current,
    () => ({ sessionId: refs.sessionId ?? undefined, cwd }),
  ))

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
  session: SessionContext
  /**
   * Wave J: 可选共享 ProviderHealthTracker。sidecar 多 session + switchModel
   * 频繁场景下，per-call new 会丢失累积的 provider 健康统计（成功率/延迟），
   * coordinator 的冷层路由跳过逻辑失据。传入共享实例后，registerProvider
   * 幂等不会重置已有状态。TUI 单 session 路径不传，保持原行为。
   */
  sharedProviderHealth?: ProviderHealthTracker
  /** I4: optional callback to surface user hook results to the desktop event stream. */
  emitHookResult?: import('./agent/loop-types.js').AgentConfig['emitHookResult']
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
      supportsVision: currentModel.supportsVision,
    },
    cwd,
    provider,
    allProviders: config.provider.providers,
    config,
    sessionId,
    // 全量传入；门控统一在 createAgentConfig 内经 gateToolDefinitions 施加，
    // 与 AgentLoop.updateTools() 共用同一过滤逻辑（避免 MCP/LSP 异步注册后被还原）。
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

  // Review override: pre-resolve each profile's provider/model + validate
  // credentials eagerly, but defer StreamClient construction to runtimeFactory
  // so maxTokens/thinkingBudget can be set from per-call isWrite (read vs write
  // profile). Without this deferral, override workers were hardcoded to 4096
  // even for write profiles like 'patcher' — half the token budget of normal
  // workers. Mirrors create-agent-config.ts:162-168 cross-provider client
  // factory. Skip on credential failure → fall through to primary client.
  const overrideState = config.agent.review?.profiles
    ? buildReviewOverrideState(config.agent.review.profiles, config.provider.providers)
    : { cards: new Map<string, ModelCapabilityCard>(), overrides: new Map<string, ResolvedReviewOverride>() }
  const reviewOverrideCards = overrideState.cards
  const reviewOverrides = overrideState.overrides
  const reviewOverrideApiKeys = new Map<string, string>()
  for (const [profileName, resolved] of reviewOverrides) {
    try { reviewOverrideApiKeys.set(profileName, resolveApiKey(resolved.providerConfig)) } catch {
      debugLog(`[review-override] skip ${profileName}: no API key for ${resolved.providerName}`)
      reviewOverrides.delete(profileName)
      reviewOverrideCards.delete(profileName)
    }
  }

  // Worker routing
  const workerRouting = config.workers?.profiles && Object.keys(config.workers.profiles).length > 0
    ? { profiles: config.workers.profiles, routing: config.workers.routing, providers: config.provider.providers }
    : undefined

  // Physarum provider health: shared between main loop (sensorium stability)
  // and coordinator (cold-tier routing skip). Stream outcomes feed weights.
  // Wave J: sidecar 可传 sharedProviderHealth 让 health 数据跨 session +
  // switchModel 持久（registerProvider 幂等不重置已有状态）；TUI 不传则保持
  // per-call new 的原行为（单 session 进程影响有限）。
  const providerHealth = deps.sharedProviderHealth ?? new ProviderHealthTracker()
  providerHealth.registerProvider(provider.name)
  if (workerRouting?.providers) {
    for (const name of Object.keys(workerRouting.providers)) providerHealth.registerProvider(name)
  }

  const runtimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => {
    const writeProfiles = profileRegistry.listWriteProfiles()
    const isWrite = writeProfiles.includes(_order.profile)

    // Per-order modelOverride: highest precedence (above review override and
    // workers routing). Builds a dedicated client for the seat's provider/model
    // so e.g. a council with one DeepSeek-Pro seat and one GLM seat runs each on
    // its own server-side cache. Falls through to normal routing when the
    // provider is unknown / lacks the model / has no credentials (silent
    // fallback, consistent with the other routing layers).
    if (_order.modelOverride) {
      const ovProvider = config.provider.providers[_order.modelOverride.provider]
      const ovModel = _order.modelOverride.model
      const ovModelOk = ovProvider?.models.some(m => m.id === ovModel || m.alias === ovModel)
      if (ovProvider && ovModelOk) {
        let ovApiKey = ''
        let ovAuth: ReturnType<typeof createAuthProvider> | undefined
        let ovReady = false
        try {
          if (ovProvider.auth?.type === 'oauth') {
            ovAuth = ovProvider.name === provider.name ? auth : createAuthProvider(ovProvider.auth, process.env)
            ovReady = Boolean(ovAuth?.isAuthenticated())
          } else {
            ovApiKey = resolveApiKey(ovProvider)
            ovReady = Boolean(ovApiKey)
          }
        } catch {
          ovReady = false
        }
        if (ovReady) {
          const ovSpec = ovProvider.models.find(m => m.id === ovModel || m.alias === ovModel)
          const ovContextWindow = ovSpec?.contextWindow ?? card.contextWindow
          const ovMaxTokens = isWrite
            ? Math.min(8192, ovSpec?.maxTokens ?? ovContextWindow)
            : Math.min(4096, ovSpec?.maxTokens ?? ovContextWindow)
          const ovCapabilities = resolveCapabilities(ovProvider.name, ovProvider.capabilities)
          debugLog(`[worker-model] modelOverride active: profile=${_order.profile} authority=${_order.authority} → ${ovProvider.name}/${ovModel} isWrite=${isWrite}`)
          return {
            order: _order,
            providerName: ovProvider.name,
            client: createProviderClient(ovProvider, ovCapabilities, {
              apiKey: ovApiKey,
              model: ovModel,
              reasoningEffort: undefined,
              maxTokens: ovMaxTokens,
              thinkingBudget: isWrite ? 8192 : 4096,
              auth: ovAuth,
            }),
            promptEngine: new PromptEngine({
              model: ovModel,
              maxTokens: ovMaxTokens,
              staticCtx: { tools: workerRegistry.getDefinitions() },
              volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock() },
            }),
            toolRegistry: workerRegistry,
            cwd,
            maxTurns: 40,
            contextWindow: ovContextWindow,
            compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
            activeClaims: claimStore.listActiveClaims(),
            domainKnowledgeStore,
            forceJsonRepair: ovCapabilities.supportsResponseFormat,
          }
        }
        debugLog(`[worker-model] modelOverride skip: ${_order.modelOverride.provider}/${ovModel} no credentials → fallback`)
      } else {
        debugLog(`[worker-model] modelOverride skip: provider=${_order.modelOverride.provider} modelOk=${ovModelOk} → fallback`)
      }
    }

    // Review override fast path: if the profile is configured for a different
    // provider, use the pre-resolved override (different provider+model from
    // session primary). This is the whole point of the override — review
    // workers must NOT touch the session primary's server-side cache (GLM
    // cache-killer mechanism). StreamClient is built lazily here (not at
    // bootstrap) so maxTokens/thinkingBudget reflect this call's isWrite —
    // write profiles (e.g. 'patcher') get 8192, read-only profiles get 4096,
    // matching the non-override worker path.
    const overrideResolved = reviewOverrides.get(_order.profile)
    if (overrideResolved) {
      const overrideApiKey = reviewOverrideApiKeys.get(_order.profile)
      if (!overrideApiKey) {
        debugLog(`[review-override] skip ${_order.profile}: no cached API key (credential failure at bootstrap)`)
      } else {
        const overrideSpec = overrideResolved.providerConfig.models.find(
          m => m.id === overrideResolved.modelId || m.alias === overrideResolved.modelId,
        )
        const overrideContextWindow = overrideSpec?.contextWindow ?? card.contextWindow
        const overrideMaxTokens = isWrite
          ? Math.min(8192, overrideSpec?.maxTokens ?? overrideContextWindow)
          : Math.min(4096, overrideSpec?.maxTokens ?? overrideContextWindow)
        debugLog(`[worker-model] review-override active: profile=${_order.profile} model=${overrideResolved.modelId} isWrite=${isWrite}`)
        const overrideCapabilities = resolveCapabilities(overrideResolved.providerName, overrideResolved.providerConfig.capabilities)
        return {
          order: _order,
          providerName: overrideResolved.providerName,
          client: createProviderClient(
            overrideResolved.providerConfig,
            overrideCapabilities,
            {
              apiKey: overrideApiKey,
              model: overrideResolved.modelId,
              reasoningEffort: undefined,
              maxTokens: overrideMaxTokens,
              thinkingBudget: isWrite ? 8192 : 4096,
            },
          ),
          promptEngine: new PromptEngine({
            model: overrideResolved.modelId,
            maxTokens: overrideMaxTokens,
            staticCtx: { tools: workerRegistry.getDefinitions() },
            volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock() },
          }),
          toolRegistry: workerRegistry,
          cwd,
          maxTurns: 40,
          contextWindow: overrideContextWindow,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
          activeClaims: claimStore.listActiveClaims(),
          domainKnowledgeStore,
          forceJsonRepair: overrideCapabilities.supportsResponseFormat,
        }
      }
    }

    let workerProvider = provider
    let workerApiKey = apiKey
    let workerAuth = auth
    let workerModel = card.model

    if (workerRouting) {
      const routeName = workerRouting.routing[mapWorkOrderKindToCapabilityTask(_order.kind)]
      if (routeName && workerRouting.profiles[routeName]) {
        const routeProfile = workerRouting.profiles[routeName]
        const resolved = config.provider.providers[routeProfile.provider]
        // Route to the configured provider+model as long as the provider exists and
        // actually offers the configured model. The previous guard required
        // `routeProfile.model === card.model`, which defeated the whole point of
        // worker routing (independent model → isolated server-side prefix cache):
        // any profile configured with a DIFFERENT model was silently skipped and
        // workers fell back to the primary model, competing with the primary
        // session's cache entries. Now we allow a distinct model and set it on
        // workerModel so the worker actually runs on the routed model.
        if (resolved && resolved.models.some(m => m.id === routeProfile.model || m.alias === routeProfile.model)) {
          try {
            if (resolved.auth?.type === 'oauth') {
              const routedAuth = resolved.name === provider.name
                ? auth
                : createAuthProvider(resolved.auth, process.env)
              if (routedAuth?.isAuthenticated()) {
                workerProvider = resolved
                workerModel = routeProfile.model
                workerApiKey = ''
                workerAuth = routedAuth
              }
            } else {
              workerProvider = resolved
              workerModel = routeProfile.model
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

    const workerCapabilities = resolveCapabilities(workerProvider.name, workerProvider.capabilities)
    return {
      order: _order,
      providerName: workerProvider.name,
      client: createProviderClient(workerProvider, workerCapabilities, {
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
      maxTurns: 40,
      contextWindow: workerContextWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      activeClaims: claimStore.listActiveClaims(),
      domainKnowledgeStore,
      // Use response_format: json_object on repair turns when the provider
      // supports it — forces valid JSON output, eliminating the most common
      // worker-result parse-failure cause (free-text prose / truncation).
      // Only applied to the tool-free repair turn, so it never conflicts with
      // function calling on normal turns.
      forceJsonRepair: workerCapabilities.supportsResponseFormat,
    }
  }

  // EFE routing pulls per-turn signals from the agent. Build the agent first so
  // its ArtifactStore can be wired into the coordinator for worker artifact fallback.
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

  const agent = new AgentLoop(
    {
      ...agentCfg,
      toolRegistry,
      // YOLO 联动无限轮次——启动恢复路径。运行时切换（/yes、权限面板、sidecar
      // serve.ts）都会把 maxTurns 置 0，唯独「持久化 YOLO 为默认 → 重启」的构造
      // 路径漏了联动：YOLO 会话按 config maxTurns（如 50）跑，turn 45 注入预算
      // 预警、turn 50 被 GUARD 硬截断（session 92a38900，用户观感=自己停止）。
      maxTurns: config.agent.approval === 'dangerously-skip-permissions' ? 0 : config.agent.maxTurns,
      checkpointEveryTurns: config.agent.checkpointEveryTurns,
      getSessionMemoryState: () => persist.getSessionMemoryState(),
      fileHistory,
      contextClaimStore: claimStore,
      // Playbook 默认停用（2026-07-06，RIVET_PLAYBOOK=1 重新启用）。取证结论：
      // 注入内容是错误转储级噪音（deliver_task 报文原样入库、context 字段 merge
      // 滚雪球），且 matchScore 的 useCount 加成 + recordUsage 强化构成自增强回路
      // ——垃圾教训越注入越常被选中、几乎不衰减（单项目 2 条垃圾 ×8 会话注入）。
      // 不构造 store 即全链路关闭：注入 / dream 蒸馏 / playbook-reflect 收割 /
      // recordUsage 均为判空跳过。修复质量闸前不要复活（上次复活见 80e0c530）。
      playbookStore: process.env['RIVET_PLAYBOOK'] === '1' ? new PlaybookStore(cwd) : undefined,
      providerHealth,
      effortBanditEnabled: effortGate.enabled,
      taskLedger: refs.taskLedger ?? undefined,
      ownershipLedger: refs.ownershipLedger ?? undefined,
      verificationSnapshotManager: refs.verificationSnapshotManager ?? undefined,
      // T4: late-bound LSP manager — initialized asynchronously after agent creation
      getLspManager: () => refs.lspManager,
      // Track 3 门禁合一：badge 与收敛检测读权威 v2 状态。
      deliveryGateV2: refs.deliveryGate
        ? (dirty) => refs.deliveryGate!.assess([], dirty)
        : undefined,
      meridianIndexer: refs.meridianIndexer,
      modelRoutingShadowModelCards: modelCards,
      domainKnowledgeStore,
      emitHookResult: deps.emitHookResult,
      // 多会话隔离：turn-end 任务进度回灌与 todo-reminder 快照统一读本会话 store。
      // TUI 下 refs.todoStore 即全局 defaultStore（行为不变）；server 下每会话独立。
      // 闭包绑定 refs（switchModel 重建 loop 时复用同一 refs/todoStore）→ 守住缓存不变量。
      getTodos: () => refs.todoStore.read(),
    },
    deps.session,
    cwd,
  )
  agentForSignals = agent

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
    artifactStore: agent.artifactStore,
    resumeEnabled: true,
    reviewOverrideCards: reviewOverrideCards.size > 0 ? reviewOverrideCards : undefined,
    maxDelegationDepth: config.agent.maxDelegationDepth,
    // Shared-worktree mode: write workers run directly in the controller's single
    // shared cwd/branch (no per-worker git worktree, no diff回流/apply_patch merge).
    // Orthogonal shards write disjoint files; the file-claim registry +
    // groupTeamTasks same-file serialization prevent stomping. Mirrors the real
    // "multiple sessions, one branch" workflow.
    sharedWorktree: true,
    patcherTier: config.workers.patcherTier,
    escalationCap: config.workers.escalationCap,
    // Downward trust delegation: a primary running dangerously-skip-permissions
    // opted out of all prompts, so its workers inherit that. Any other mode is
    // ignored downstream — workers rely on headless approval semantics instead.
    parentApprovalMode: config.agent.approval as import('./agent/loop-types.js').ApprovalMode,
  })

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
      // Use debugLog instead of console.error — console.error writes directly
      // to stderr, bypassing the LiveEngine's row management. When MCP loads
      // asynchronously after the TUI's first frame, this rogue line corrupts
      // the engine's cursor tracking, causing double-border ghost rendering
      // on the next slash-command redraw.
      debugLog(`[MCP] ${parts.join('; ')}`)
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
  // Polyglot: the multi-language manager routes each file to its matching
  // server (typescript-language-server / pyright / gopls / rust-analyzer /
  // clangd / jdtls), lazily spawning installed ones on first use.
  const lspManager = createMultiLspManager(cwd)

  try {
    await lspManager.initialize()
    if (lspManager.isReady()) {
      toolRegistry.register(createGotoDefinitionTool(lspManager))
      toolRegistry.register(createFindReferencesTool(lspManager))
      if (process.env['RIVET_DEBUG']) {
        const servers = availableServers().map(s => s.id).join(', ')
        console.error(`[LSP] polyglot LSP ready — available servers: ${servers}`)
      }
    } else if (process.env['RIVET_DEBUG']) {
      console.error('[LSP] no language servers installed — code-intelligence tools not registered')
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
  const stateDirPath = stateDir()
  const { SessionRegistry } = await import('./agent/session-registry.js')
  const registry = await SessionRegistry.create(stateDirPath)

  // Reap dead sessions' registry rows/claims so they don't block fresh claims.
  // Default startup is fresh — we do NOT auto-resume crashed sessions; this only
  // releases their locks. Recover a crashed session explicitly with
  // `rivet --continue` (most recent) or `rivet --resume <id>`.
  const crashedSessions = registry.detectCrashedSessions()
  if (crashedSessions.length > 0) {
    // 一行短提示即可——恢复入口（--continue/--resume）在 /help 与历史会话提示里都有。
    console.error(`↺ 已清理 ${crashedSessions.length} 个异常退出会话的锁定`)
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
      // Mark a clean exit. Next startup mints a fresh session by default;
      // returning here requires explicit --continue / --resume <id> (R1).
      try { ctx.persist.updateMetadata({ cleanExit: true }) } catch { /* best-effort */ }
      ctx.persist.compactOai(ctx.session.getMessages())
      if (ctx.fileHistory) {
        persistFileHistory(
          join(getSessionDir(ctx.cwd), ctx.sessionId, 'file-history.json'),
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
      // Wave K (P0): clear stallSweep interval + abort in-flight workers.
      // 进程退出时 OS 会回收，但显式 shutdown 让语义清晰、并对齐 sidecar 的
      // switchModel 路径。同时让 unit test 退出更干净（unref 的 timer 不必依赖
      // process 真退出来释放）。
      try { ctx.refs.coordinator?.shutdown() } catch { /* best-effort */ }
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
      if (provName !== ctx.provider.name || provKey !== apiKey) {
        provider = prov
        apiKey = provKey
        auth = undefined
      }
    }

    // Wave K (P0 同源修复): createAgentRuntime 内部会 new DelegationCoordinator
    // 写入 refs.coordinator，旧 coordinator 被覆盖但其 stallSweep 定时器与在途
    // worker AbortController 仍在持有句柄。TUI 单 session 进程 + switch 频率低，
    // 影响有限——但与 sidecar 同源 (serve.ts 已修)，一并对齐避免长会话切换密集
    // 场景累积泄漏。
    const oldCoordinator = ctx.refs.coordinator

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
      session: ctx.session,
    })

    ctx.agent = agent
    ctx.refs.promptEngine = agent.config.promptEngine
    ctx.refs.getTaskContract = () => agent.getTaskContract()
    ctx.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
    ctx.refs.getSessionVitals = () => agent.getSessionVitals()
    ctx.provider = provider
    ctx.apiKey = apiKey
    ctx.auth = auth

    // 同一身份判等防御：若装配未实际替换 coordinator（理论不该发生），不动旧的。
    if (oldCoordinator && oldCoordinator !== ctx.refs.coordinator) {
      try { oldCoordinator.shutdown() } catch { /* best-effort: shutdown is fail-open */ }
    }

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

export interface SwitchSessionResult {
  ok: boolean
  error?: string
  /** 成功时:载入的消息条数 / 是否做了 orphan 修复 / preflight 是否 apiSafe */
  messageCount?: number
  repaired?: boolean
  safe?: boolean
}

/**
 * 运行时会话身份切换（TUI /resume <id>）。与 switchAgentRuntime 同构:通过
 * createAgentRuntime 整体重建 AgentLoop —— 构造函数内部按 targetId 重建所有
 * sessionId-bound 子系统(persist / telemetryWriter / stigmergyStore /
 * artifactStore / sessionStateManager 与持久化监听),从此 会话id = 日志id =
 * pointer id = registry id 名副其实,彻底修掉"看着是旧会话、其实写进原 id"的身份分裂。
 *
 * targetId 必须是已解析的完整 id(调用方用 SessionPersist.resolveSessionId 解析短前缀)。
 * resume 全量 replay 目标历史(显式代价、会重建前缀缓存),不跨会话吃当前上下文。
 */
export function switchAgentSession(ctx: BootstrapContext, targetId: string): SwitchSessionResult {
  if (targetId === ctx.sessionId) {
    return { ok: false, error: '已经在该会话中。' }
  }

  let targetPersist: SessionPersist
  try {
    targetPersist = new SessionPersist(targetId, ctx.cwd)
  } catch (err) {
    return { ok: false, error: `无法打开会话 ${targetId.slice(0, 8)}: ${(err as Error).message}` }
  }

  // 跨 cwd 守卫:别让别的项目会话渗进当前 cwd。
  const meta = targetPersist.loadMetadata()
  if (meta?.cwd && meta.cwd !== ctx.cwd) {
    return { ok: false, error: '该会话属于其他工作目录,拒绝载入。' }
  }

  const rawMsgs = targetPersist.loadOai()
  const preflight = runResumePreflightOai(rawMsgs, { writeProbe: createWriteEvidenceProbe(ctx.cwd) })

  // 仅换会话身份,保留当前模型。
  let currentModelId: string | undefined
  try { currentModelId = ctx.agent.config.promptEngine.getModel() } catch { /* idle/未初始化 */ }

  // flush 旧会话的 volatile store(信息素),避免切换丢数据。
  try { ctx.agent.stigmergyStore.flushSync() } catch { /* best-effort */ }

  const oldId = ctx.sessionId
  // Wave K (P0 同源修复): 与 switchAgentRuntime 同源——createAgentRuntime 会
  // new DelegationCoordinator 写入 refs.coordinator，需在装新后关闭旧的避免
  // stallSweep 定时器 + 在途 worker 句柄泄漏。
  const oldCoordinator = ctx.refs.coordinator

  // 整体重建 AgentLoop —— 构造函数内部按 targetId 重建子系统并重挂持久化监听。
  const { agent } = createAgentRuntime({
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    config: ctx.config,
    sessionId: targetId,
    cwd: ctx.cwd,
    toolRegistry: ctx.toolRegistry,
    persist: targetPersist,
    claimStore: ctx.claimStore,
    fileHistory: ctx.fileHistory,
    refs: ctx.refs,
    domainKnowledgeStore: ctx.domainKnowledgeStore,
    modelId: currentModelId,
    session: ctx.session,
  })

  // 原地更新 ctx —— 持有 ctx 引用的闭包(onSubmit/onAbort/handlerCtx)即时一致。
  ctx.agent = agent
  ctx.persist = targetPersist
  ctx.sessionId = targetId
  ctx.refs.sessionId = targetId
  ctx.refs.promptEngine = agent.config.promptEngine
  ctx.refs.getTaskContract = () => agent.getTaskContract()
  ctx.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
  ctx.refs.getSessionVitals = () => agent.getSessionVitals()

  // 同一身份判等防御：装配实际替换 coordinator 才关旧的。
  if (oldCoordinator && oldCoordinator !== ctx.refs.coordinator) {
    try { oldCoordinator.shutdown() } catch { /* best-effort */ }
  }

  // 载入历史 —— 新 AgentLoop 的持久化监听会把 replace 镜像回 targetPersist。
  ctx.session.replaceMessages(preflight.messages)

  // pointer + registry + 缓存 sessionId 一并切到 targetId,使下次 --continue 命中它。
  try { writeFileSync(lastSessionPointerFile(ctx.cwd), targetId) } catch { /* ignore */ }
  _cachedSessionId = targetId
  _sessionWasResumed = true
  try {
    ctx.refs.sessionRegistry?.unregister(oldId)
    ctx.refs.sessionRegistry?.register(targetId, ctx.cwd)
  } catch { /* registry best-effort */ }

  return {
    ok: true,
    messageCount: preflight.messages.length,
    repaired: preflight.repaired,
    safe: preflight.safe,
  }
}

// ── Plan-mode restore（resume/切换会话共用）─────────────────────

/**
 * Re-enter plan mode from persisted session metadata after a resume or an
 * in-app session switch. The runtime plan-mode state lives in AgentLoop memory
 * and dies with the process; the meta mirror (written by syncPlanModeToConfig)
 * lets us restore it. Returns the restored draft path, or null when the session
 * was not planning / the draft file no longer exists (silent downgrade to off).
 */
export function restorePlanModeFromMeta(
  agent: AgentLoop,
  cwd: string,
  meta: Pick<import('./context/types.js').SessionMetadata, 'planModeState' | 'activePlanFilePath'> | null | undefined,
): string | null {
  if (meta?.planModeState !== 'planning' || !meta.activePlanFilePath) return null
  const rel = meta.activePlanFilePath.replace(/\\/g, '/')
  if (!existsSync(join(cwd, rel))) return null
  agent.enterPlanMode({ planFilePath: rel })
  return rel
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
  setTargetConventions(config.editor.platform, config.editor.eol)
  applyConfiguredGitBashPath(config.env.gitBashPath)

  // Announce the command sandbox's protection level up-front. Stays silent when
  // a real kernel boundary is active; warns loudly (esp. on native Windows or
  // RIVET_NO_SANDBOX) when writes are unbounded and rollback is the only — and
  // only after-the-fact, file-only — safety net.
  maybeWarnNoSandbox({ cwd })

  // Re-activate out-of-workspace path grants the user chose to "remember" for
  // this workspace, so previously-approved external paths work from turn one.
  loadPersistedGrants(cwd)
  // Standing config-declared grants (permissions.additionalReadDirs/WriteDirs):
  // Codex-style folder authorization without an approval round-trip.
  applyConfiguredPathGrants(config.agent.permissions)

  // 3. Provider + Auth
  const { provider, apiKey, auth } = resolveProviderAndAuth(config, opts.providerName)

  // 4. Session infrastructure
  const { registry: sessionRegistry, sessionId, heartbeatInterval } = await createSessionInfrastructure()

  // 4a. First-run template detection — set flag for TUI layer to prompt.
  // We only detect here; actual file creation + sentinel write happens in
  // main.ts after the user decides (so file creation and sentinel stay atomic).
  const templatesPendingAgents = needsTemplatesInit(cwd)

  // 5. Session persist + claim store
  const persist = new SessionPersist(sessionId, cwd)
  const claimStore = persist.createClaimStore()
  persist.injectDurableClaims(claimStore, cwd)
  for (const rule of loadProjectRules(cwd)) {
    claimStore.propose(rule)
  }
  // A3: no-test-infra advisory — recomputed live each session (disappears the
  // moment tests exist). Only for recognized languages: docs/unknown repos
  // would be pure noise. Makes the delivery-gate impact explicit and nudges
  // 主控 to offer a minimal test scaffold instead of silently degrading.
  try {
    const fp = detectProjectFingerprint(cwd)
    if (fp.language !== 'unknown' && !fp.hasTestInfra) {
      const now = Date.now()
      claimStore.propose({
        kind: 'project_rule',
        scope: 'project',
        text: `本项目（${fp.language}）未检测到测试基础设施。影响：deliver_task 交付门禁会因无验证证据降级为 YELLOW。首次合适时机向用户说明此影响，并主动提出「要我帮你搭一个最小测试骨架吗」（不强制——尊重用户选择，但让影响显性化）。`,
        confidence: 1.0,
        fitness: 5,
        source: { actor: 'hook', sessionId: 'project', turn: 0, eventId: 'fingerprint:no-test-infra' },
        evidence: [{ id: 'fingerprint:no-test-infra', kind: 'file', summary: `project fingerprint: language=${fp.language}, hasTestInfra=false`, path: cwd, createdAt: now }],
        createdAt: now,
        tags: ['no_test_infra'],
      })
    }
  } catch { /* advisory only — never block bootstrap */ }
  const skillLoad = loadProjectSkills(cwd, { importFromClaude: config.skills?.importFromClaude })
  if (skillLoad.loaded.length > 0 && process.env['RIVET_DEBUG']) {
    // 常规启动不打（/skills 可随时查看已加载技能）——首屏保持干净。
    console.error(`[skills] Loaded ${skillLoad.loaded.length} skill(s)`)
  }
  for (const err of skillLoad.errors) {
    console.warn(`[skills] ${err}`)
  }
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const session = new SessionContext()

  // Load prior messages. When the session id was explicitly resumed
  // (--continue / --resume <id>), this rehydrates that session's history.
  const existingMessages = persist.loadOai()
  if (existingMessages.length > 0) {
    session.replaceMessages(existingMessages)
    if (wasSessionResumed()) {
      console.error(`🔄 已恢复会话 ${sessionId.slice(0, 8)}: ${existingMessages.length} 条消息(将重建前缀缓存)。默认启动为全新会话；指定会话用 rivet --resume <id>,查看列表用 rivet --list。`)
    }
  }

  // Evict old sessions
  evictOldSessions(sessionId, cwd)

  // Clean up stale worker session directories under ~/.rivet/sessions/<slug>/.
  // Worker sessions create worker-xxx/ (pheromones, sensorium).
  cleanupStaleWorkerSessionDirs(cwd)

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

  // Memory epoch reset — 首次/升级后启动时一次性清空中毒的跨会话学习存量
  // （playbook.jsonl / recovery-journal / advisory-efficacy / mistake_entries），
  // 见 memory-epoch.ts 取证背景。必须在 loadSessionMemories warmup 之前跑，
  // 否则旧 mistake entries 先被载入内存、会话末又原样存回。
  try {
    const memReset = resetLegacyMemoryIfNeeded(cwd, {
      clearMistakeEntries: () => meridianIndexer.getDb().clearMistakeEntries(),
    })
    if (!memReset.skipped && memReset.cleared.length > 0) {
      console.error(`[startup] Memory epoch ${memReset.epoch}: cleared ${memReset.cleared.join(', ')}`)
    }
  } catch { /* 清理绝不阻塞启动 */ }

  // 7. Domain knowledge store
  const domainKnowledgeStore = new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))

  // 8. Load profiles + star domains
  const agentsDir = join(cwd, '.rivet', 'agents')
  const agentLoadResult = await profileRegistry.loadFromDirectory(agentsDir)
  if (agentLoadResult.loaded.length > 0 || agentLoadResult.errors.length > 0) {
    for (const err of agentLoadResult.errors) {
      console.warn(`[agents] ${err}`)
    }
  }
  const domainsDir = join(cwd, '.rivet', 'domains')
  const domainLoadResult = await starDomainRegistry.loadFromDirectory(domainsDir)
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
    verificationSnapshotManager: null,
    deliveryGate: null,
    meridianIndexer,
    mcpManager: null,
    lspManager: null,
    banditState: null,
    promptEngine: null,
    goalTrackerRef: { current: null },
    // TUI 单会话：复用全局 defaultStore，沿用其 setTodoSession/loadTodos 持久化与
    // 会话切换语义（行为零变化），仅把后端读取入口统一到 refs.todoStore。
    todoStore: defaultTodoStore,
  }

  // 10. Tool registry
  const { registry: toolRegistry } = createInteractiveToolRegistry(refs, config, cwd)

  // 11. Memory tool (unified recall + remember)
  toolRegistry.register(createMemoryTool(claimStore, {
    sessionId,
    getTurn: () => session.getTurnCount(),
    cwd,
  }))

  // 12. Agent runtime
  const { agent } = createAgentRuntime({
    provider, apiKey, auth, config, sessionId, cwd,
    toolRegistry, persist, claimStore, fileHistory, refs,
    domainKnowledgeStore, modelId: opts.modelId,
    session,
  })
  refs.promptEngine = agent.config.promptEngine
  refs.getTaskContract = () => agent.getTaskContract()
  refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
  refs.getSessionVitals = () => agent.getSessionVitals()

  // 12b. Restore goal tracker from persisted state (if session was resumed).
  // normalizeAfterResume: active → paused (the process that wrote active is gone).
  if (wasSessionResumed()) {
    try {
      const { restoreGoalTracker } = await import('./agent/goal-persist.js')
      const restored = restoreGoalTracker(getSessionDir(cwd), sessionId, {
        maxJudgeRuns: config.agent.goal?.judge?.maxRuns,
      })
      if (restored) {
        agent.setGoalTracker(restored)
        refs.goalTrackerRef.current = restored
        console.error(`🎯 已恢复目标（暂停状态）: ${restored.getGoal().slice(0, 60)}…  使用 /goal-resume 继续。`)
      }
    } catch { /* best-effort: goal restore failure is non-fatal */ }
  }

  // 13. MCP + Plugin + LSP initialization
  // asyncExtras (default true): fire-and-forget, non-blocking for faster startup
  // asyncExtras=false: synchronous await, completes before bootstrap returns
  if (opts.asyncExtras !== false) {
    initializeMcp(config, toolRegistry, refs).then(() => {
      agent.updateTools()
    }).catch(() => {})
    initializePlugins(config.plugins, toolRegistry, cwd).then((result) => {
      for (const name of result.suppressTools) {
        toolRegistry.remove(name)
      }
      if (result.warnings.length > 0) {
        debugLog(`[plugins] ${result.loaded}/${result.scanned} loaded, ${result.totalTools} tools; warnings: ${result.warnings.join('; ')}`)
      }
      // Always refresh tools when plugins change the registry (tools added OR suppressed).
      // Suppress-only plugins (zero own tools) must still trigger an update to remove
      // the suppressed built-in tools from the model's tool list.
      if (result.totalTools > 0 || result.suppressTools.length > 0) {
        agent.updateTools()
      }
    }).catch((err) => {
      debugLog(`[plugins] Initialization failed: ${(err as Error).message}`)
    })
    initializeLsp(cwd, toolRegistry).then((lspManager) => {
      refs.lspManager = lspManager
      agent.updateTools()
    }).catch(() => {})
  } else {
    await initializeMcp(config, toolRegistry, refs)
    agent.updateTools()
    const pluginResult = await initializePlugins(config.plugins, toolRegistry, cwd)
    for (const name of pluginResult.suppressTools) {
      toolRegistry.remove(name)
    }
    if (pluginResult.warnings.length > 0) {
      debugLog(`[plugins] ${pluginResult.loaded}/${pluginResult.scanned} loaded, ${pluginResult.totalTools} tools; warnings: ${pluginResult.warnings.join('; ')}`)
    }
    if (pluginResult.totalTools > 0) agent.updateTools()
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
    templatesPendingAgents,
  }

  return ctx
}
