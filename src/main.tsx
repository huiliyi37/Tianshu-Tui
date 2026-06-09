import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
if (proxyUrl) {
  setGlobalDispatcher(new EnvHttpProxyAgent())
}

import { readFileSync, existsSync, mkdirSync, writeFileSync, readSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { render } from 'ink'
import { createElement, useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { App } from './tui/app.js'
import { ErrorBoundary } from './tui/error-boundary.js'
import { registerResizeClear } from './tui/use-terminal-size.js'
import { AgentLoop } from './agent/loop.js'
import { createAgentConfig, createMainAgentConfigInput } from './agent/create-agent-config.js'
import { SessionContext } from './agent/context.js'
import { SessionPersist } from './agent/session-persist.js'
import { evictOldSessions } from './agent/session-persist.js'
import { FileHistory } from './agent/file-history.js'
import { persistFileHistory } from './agent/file-history-persist.js'
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
import type { AuthProvider } from './auth/types.js'
import { resolveCapabilities } from './api/provider.js'
import { DelegationCoordinator } from './agent/coordinator.js'
import { DomainKnowledgeStore } from './agent/domain-knowledge-store.js'
import { persistTeamWaveTelemetry, type TeamWaveTelemetry } from './agent/team-wave-telemetry.js'
import { buildTeamSchedulerRewardEvent, persistTeamSchedulerReward, persistTeamSchedulerShadow, type TeamSchedulerShadowEvent } from './agent/team-scheduler-shadow.js'
import { persistGatedInfluenceAudit, type GatedInfluenceAuditEvent } from './agent/gated-influence-audit.js'
import { computeTeamWaveReward, deriveTeamWaveRewardInput } from './agent/team-reward.js'
import { teamSchedulerArmForParallelism } from './agent/team-scheduler-bandit.js'
import { recordTeamWaveRewardClosure } from './agent/reward-loop.js'
import { createCoordinatorReviewDeps } from './agent/review-coordinator-deps.js'
import { mapWorkOrderKindToCapabilityTask } from './agent/work-order.js'
import { profileRegistry } from './agent/profile-registry.js'
import { starDomainRegistry } from './agent/star-domain-registry.js'
import type { WorkerRuntimeFactory } from './agent/coordinator.js'
import type { ModelCapabilityCard } from './model/capability.js'
import { killAllSync } from './tools/process-tracker.js'
import { runConfigCLI, loadConfig as loadLayeredConfig } from './config/manager.js'
import { loadProjectRules } from './context/rules-loader.js'
import { createRecallTool } from './tools/recall.js'
import { createRememberTool } from './tools/remember.js'
import { createRepoGraphTool } from './tools/repo-graph.js'
import { MeridianIndexer } from './repo/meridian-indexer.js'
import { ASK_USER_QUESTION_TOOL } from './tools/ask-user-question.js'
import { PlaybookStore } from './agent/playbook-store.js'
import type { Config, ProviderConfig } from './config/schema.js'
import { spawnSync, spawn } from 'node:child_process'
import type { BaselineSnapshot } from './agent/worktree-baseline.js'
import { cleanupOrphanedTmpFiles } from './fs-atomic.js'
import { cleanupOldArtifactSessions } from './artifact/store.js'
import { createLspManager } from './lsp/manager.js'
import { createGotoDefinitionTool, createFindReferencesTool } from './lsp/tools.js'

function captureGitBaseline(cwd: string): BaselineSnapshot {
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

function loadConfig(cwd?: string, args = process.argv.slice(2)): Config {
  return loadLayeredConfig({ cwd, sessionOverlay: approvalOverlayFromArgs(args) })
}

let _cachedSessionId: string | null = null
function getOrCreateSessionId(): string {
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

// Module-level shutdown callback — set by Root component, called by signal handlers
let shutdownCallback: (() => void) | null = null

// Module-level initial input (from pipe stdin)
let _pipedInput: string | undefined

// Module-level mutable coordinator reference — updated on model switch,
// read by the delegate_task tool's execute method.
let _coordinatorRef: DelegationCoordinator | null = null

// Module-level FileHistory reference — created in Root, read by undo tool
let _fileHistoryRef: FileHistory | null = null

// Module-level claim store reference — created in Root, read by delegate_task tool
let _claimStoreRef: import('./context/claim-store.js').ContextClaimStore | null = null
let _sessionIdRef: string | null = null
let _sessionRegistryRef: import('./agent/session-registry.js').SessionRegistry | null = null
// Module-level TaskLedger reference — created in tool registry, read by AgentLoop config
let _taskLedgerRef: import('./agent/task-ledger.js').TaskLedger | null = null
let _ownershipLedgerRef: import('./agent/ownership-ledger.js').OwnershipLedger | null = null

// Module-level Meridian indexer reference — created lazily, read by repo_graph tool
let _meridianIndexerRef: import('./repo/meridian-indexer.js').MeridianIndexer | null = null

// Module-level MCP manager reference — initialized in Root, shut down on exit
let _mcpManager: any = null

let isShuttingDown = false

// Module-level handles so gracefulShutdown can release everything that keeps
// the libuv event loop alive (timers, MCP stdio pipes). Without this, a closed
// terminal (SIGHUP) leaves the process running as an orphan.
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null
let _perfCleanup: ReturnType<typeof setInterval> | null = null

function gracefulShutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  // The callback persists session state via SYNCHRONOUS writes (compactOai,
  // persistFileHistory). On a full disk / permission error those throw — so it
  // must not gate the kill+exit below, or the process hangs with all children
  // alive ("卡死冻屏"). Everything that MUST run on exit goes in `finally`.
  // (root-cause analysis 2026-06-05, Thread 1B)
  try {
    shutdownCallback?.()
  } catch (err) {
    try { process.stderr.write(`[shutdown] callback error: ${(err as Error)?.message}\n`) } catch { /* noop */ }
  } finally {
    if (_heartbeatInterval) clearInterval(_heartbeatInterval)
    if (_perfCleanup) clearInterval(_perfCleanup)
    // MCP children are spawned by the SDK (not via process-tracker), so
    // killAllSync can't reach them. Force-kill them inline — the async
    // shutdown() below would be abandoned by process.exit. (Thread 1A)
    try { _mcpManager?.killChildrenSync?.() } catch { /* best-effort */ }
    void _mcpManager?.shutdown?.()
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false)
    }
    killAllSync()
    process.exit(0)
  }
}

function Root({ provider, apiKey, config, auth, initialModelId }: { provider: ProviderConfig; apiKey: string; config: Config; auth?: AuthProvider; initialModelId?: string }) {
  const initialInput = _pipedInput
  const cwd = process.cwd()

  // Base tool registry — contains all core tools, no delegate_task.
  // Used as the worker base registry (delegate_task must not enter worker allowlist).
  const [toolRegistry] = useState(() => {
    const reg = createDefaultToolRegistry()
    // Register delegate_task with a mutable coordinator reference.
    // The coordinator is recreated in useMemo on model switch; the tool reads
    // the latest via a closure over a module-level ref.
    reg.register(createDelegateTaskTool(
      {
        delegate: async (request) => {
          if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
          return _coordinatorRef.delegate(request)
        },
      },
      () => _claimStoreRef ?? undefined,
      () => _sessionIdRef ?? undefined,
    ))
    reg.register(createUndoTool(() => _fileHistoryRef ?? undefined))
    reg.register(createDelegateBatchTool({
      delegateBatch: async (requests, policy, abortSignal, onProgress) => {
        if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
        return _coordinatorRef.delegateBatch(requests, policy, abortSignal, onProgress)
      },
    },
      () => _claimStoreRef ?? undefined,
      () => _sessionIdRef ?? undefined,
    ))
    reg.register(createTeamOrchestrateTool({
      delegate: async (request, abortSignal) => {
        if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
        return _coordinatorRef.delegate(request, abortSignal)
      },
      delegateBatch: async (requests, policy, abortSignal, onProgress) => {
        if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
        return _coordinatorRef.delegateBatch(requests, policy, abortSignal, onProgress)
      },
      recordTeamWaveTelemetry: (event: TeamWaveTelemetry) => {
        persistTeamWaveTelemetry(_meridianIndexerRef?.getDb(), event)
      },
      recordTeamWaveRewardClosure: (event: TeamWaveTelemetry) => {
        recordTeamWaveRewardClosure(_meridianIndexerRef?.getDb(), event)
      },
      recordTeamSchedulerShadow: (event: TeamSchedulerShadowEvent) => {
        persistTeamSchedulerShadow(_meridianIndexerRef?.getDb(), event)
      },
      recordGatedInfluenceAudit: (event: GatedInfluenceAuditEvent) => {
        persistGatedInfluenceAudit(_meridianIndexerRef?.getDb(), event)
      },
      recordTeamSchedulerReward: (event: TeamWaveTelemetry) => {
        const rewardInput = deriveTeamWaveRewardInput(event)
        persistTeamSchedulerReward(_meridianIndexerRef?.getDb(), buildTeamSchedulerRewardEvent({
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
      getTeamSchedulerRewardStore: () => _meridianIndexerRef?.getDb(),
      isTeamSchedulerBanditEnabled: () => config.agent.teamSchedulerBanditEnabled === true,
      getSessionId: () => _sessionIdRef ?? undefined,
    }))
    reg.register(createRecallCapsuleTool(() => cwd))
    reg.register(ASK_USER_QUESTION_TOOL)
    reg.register(createRepoGraphTool(() => _meridianIndexerRef))

    // B1 归属星轨：deliver_task 交付门工具
    // TaskLedger、OwnershipLedger、DeliveryGateV2 在此初始化，
    // 通过闭包提供给 deliver_task 工具。
    const _b1TaskLedger = createTaskLedger({ taskId: getOrCreateSessionId() })
    _taskLedgerRef = _b1TaskLedger
    const _b1Baseline = createWorktreeBaseline(captureGitBaseline(cwd))
    const _b1Ownership = createOwnershipLedger({
      baseline: _b1Baseline,
      taskLedger: _b1TaskLedger,
    })
    _ownershipLedgerRef = _b1Ownership
    const _b1Attribution = createVerificationAttribution({
      ownership: _b1Ownership,
    })
    const _b1Gate = createDeliveryGateV2({
      taskLedger: _b1TaskLedger,
      ownership: _b1Ownership,
      attribution: _b1Attribution,
    })
    reg.register(createDeliverTaskTool((params) => ({
      taskLedger: _b1TaskLedger,
      ownership: _b1Ownership,
      gate: _b1Gate,
      sessionRegistry: _sessionRegistryRef ?? undefined,
      sessionId: _sessionIdRef ?? undefined,
      reviewDepth: params?.reviewDepth ?? 0,
      reviewDeps: createCoordinatorReviewDeps({
        delegate: async (request, abortSignal) => {
          if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
          return _coordinatorRef.delegate(request, abortSignal)
        },
        delegateBatch: async (requests, policy, abortSignal, onProgress) => {
          if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
          return _coordinatorRef.delegateBatch(requests, policy, abortSignal, onProgress)
        },
      }, { reviewDepth: params?.reviewDepth ?? 0 }),
    })))

    return reg
  })

  // MCP initialization — discovers tools from configured MCP servers and registers them
  const [, setMcpReady] = useState(false)
  const mcpManagerRef = useRef<any>(null)
  const agentRef = useRef<AgentLoop | null>(null)

  useEffect(() => {
    if (!config.mcp.enabled || Object.keys(config.mcp.servers).length === 0) {
      setMcpReady(true)
      return
    }

    let cancelled = false
    import('./mcp/manager.js').then(({ McpManager }) => {
      if (cancelled) return
      const mgr = new McpManager(config.mcp)
      _mcpManager = mgr
      mcpManagerRef.current = mgr

      return mgr.initialize().then(() => {
        if (cancelled) return
        const mcpTools = mgr.getAllTools()
        for (const tool of mcpTools) {
          toolRegistry.register(tool)
        }
        setMcpReady(true)
        agentRef.current?.updateTools()

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
      })
    }).catch((err) => {
      console.error('[MCP] Initialization failed:', (err as Error).message)
      setMcpReady(true)
    })

    return () => {
      cancelled = true
      _mcpManager?.shutdown().catch(() => {})
      _mcpManager = null
      mcpManagerRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // LSP initialization — starts typescript-language-server and registers go-to-definition / find-references tools
  const [lspManager] = useState(() => {
    const cwd = process.cwd()
    return createLspManager(
      () => spawn('npx', ['-y', 'typescript-language-server', '--stdio'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      cwd,
    )
  })

  useEffect(() => {
    let cancelled = false

    lspManager.initialize().then(() => {
      if (cancelled) return
      if (lspManager.isReady()) {
        toolRegistry.register(createGotoDefinitionTool(lspManager))
        toolRegistry.register(createFindReferencesTool(lspManager))
        agentRef.current?.updateTools()
        console.error(
          `[LSP] typescript-language-server ready — ` +
          `definition: ${lspManager.supportsDefinition()}, ` +
          `references: ${lspManager.supportsReferences()}`,
        )
      } else {
        console.error('[LSP] typescript-language-server failed to initialize — tools not registered')
      }
    }).catch((err) => {
      if (!cancelled) {
        console.error('[LSP] Initialization error:', (err as Error).message)
      }
    })

    return () => {
      cancelled = true
      lspManager.dispose()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [session] = useState(() => new SessionContext())

  const [sessionId] = useState(() => getOrCreateSessionId())

  // Evict old session files — deferred to post-first-frame (S10)
  useEffect(() => {
    const t = setImmediate(() => evictOldSessions(sessionId))
    return () => clearImmediate(t)
  }, [sessionId])

  // Clean up orphaned .tmp files + old artifact sessions — deferred (S10)
  useEffect(() => {
    const t = setImmediate(() => {
      const cwd = process.cwd()
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
    })
    return () => clearImmediate(t)
  }, [sessionId])

  const [persist] = useState(() => new SessionPersist(sessionId))

  // Load prior messages off the first-frame path (S10)
  useEffect(() => {
    let cancelled = false
    const existingMessages = persist.loadOai()
    if (!cancelled && existingMessages.length > 0) session.replaceMessages(existingMessages)
    return () => { cancelled = true }
  }, [persist, session])

  const [fileHistory] = useState(() => {
    const fh = new FileHistory(persist.getBackupDir(), sessionId)
    _fileHistoryRef = fh
    return fh
  })

  const [claimStore] = useState(() => {
    const store = persist.createClaimStore()
    persist.injectDurableClaims(store)
    for (const rule of loadProjectRules(process.cwd())) {
      store.propose(rule)
    }
    return store
  })

  _claimStoreRef = claimStore
  _sessionIdRef = sessionId

  // Initialize Meridian code graph indexer
  if (!_meridianIndexerRef) {
    _meridianIndexerRef = new MeridianIndexer(cwd)
  }

  // Load user-defined agent profiles/domains once per TUI Root. Re-loading on
  // every render would make custom domain ids look like duplicates.
  const registriesLoadedRef = useRef(false)
  if (!registriesLoadedRef.current) {
    const agentsDir = join(cwd, '.rivet', 'agents')
    const agentLoadResult = profileRegistry.loadFromDirectory(agentsDir)
    if (agentLoadResult.loaded.length > 0 || agentLoadResult.errors.length > 0) {
      // Will be surfaced to user via console if needed
      for (const err of agentLoadResult.errors) {
        console.warn(`[agents] ${err}`)
      }
    }

    // Load user-defined star domains from .rivet/domains/
    const domainsDir = join(cwd, '.rivet', 'domains')
    const domainLoadResult = starDomainRegistry.loadFromDirectory(domainsDir)
    if (domainLoadResult.errors.length > 0) {
      for (const err of domainLoadResult.errors) {
        console.warn(`[domains] ${err}`)
      }
    }
    registriesLoadedRef.current = true
  }

  const [domainKnowledgeStore] = useState(() => new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge')))

  // Register recall tool once (depends on claimStore existing)
  const recallRef = useRef(false)
  if (!recallRef.current) {
    toolRegistry.register(createRecallTool(claimStore, {
      sessionId,
      getTurn: () => session.getTurnCount(),
    }))
    toolRegistry.register(createRememberTool(claimStore, {
      sessionId,
      getTurn: () => session.getTurnCount(),
      cwd,
    }))
    recallRef.current = true
  }

  // Switchable provider + model — changing either recreates client + promptEngine + agent
  const [activeProvider, setActiveProvider] = useState<ProviderConfig>(() => provider)
  const [activeApiKey, setActiveApiKey] = useState(() => apiKey)
  const [activeAuth, setActiveAuth] = useState<AuthProvider | undefined>(() => auth)
  const [currentModel, setCurrentModel] = useState(() => {
    if (initialModelId) {
      const found = provider.models.find(m => m.id === initialModelId || m.alias === initialModelId)
      if (found) return found
    }
    return provider.models[0]!
  })

  const agent = useMemo(() => {
    const playbookStore = new PlaybookStore(cwd)

    const agentCfg = createAgentConfig(createMainAgentConfigInput({
      apiKey: activeApiKey,
      model: { id: currentModel.id, maxTokens: currentModel.maxTokens, contextWindow: currentModel.contextWindow, reasoningEffort: currentModel.reasoningEffort },
      cwd,
      provider: activeProvider,
      config,
      sessionId,
      toolDefinitions: toolRegistry.getDefinitions(),
      sessionMemoryBlock: persist.buildMemoryBlock(),
      auth: activeAuth,
    }))

    // --- DelegationCoordinator ---
    // Build model capability cards for all available models in the active provider.
    // Workers use this to select the best model per task type (cheap models for search,
    // capable models for edits/refactors).
    const modelCards: ModelCapabilityCard[] = activeProvider.models.map(m => {
      const isPro = m.id.includes('pro') || m.alias?.includes('pro')
      const isFlash = m.id.includes('flash') || m.alias?.includes('flash')
      if (isPro || (!isFlash && !isPro)) {
        // Primary / capable model
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
      // Flash / cheap model
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

    const workerRouting = config.workers?.profiles && Object.keys(config.workers.profiles).length > 0
      ? { profiles: config.workers.profiles, routing: config.workers.routing, providers: config.provider.providers }
      : undefined

    const runtimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => {
      const writeProfiles = profileRegistry.listWriteProfiles()
      const isWrite = writeProfiles.includes(_order.profile)

      // Resolve worker provider: routing config → fallback to active provider.
      // Important: model selection happens in DelegationCoordinator. Only switch
      // providers when the selected card actually matches the routed profile;
      // otherwise stale user routing (e.g. codex without credentials) can pair an
      // active-provider model with an unavailable routed provider.
      let workerProvider = activeProvider
      let workerApiKey = activeApiKey
      let workerAuth = activeAuth
      let workerModel = card.model
      if (workerRouting) {
        const routeName = workerRouting.routing[mapWorkOrderKindToCapabilityTask(_order.kind)]
        if (routeName && workerRouting.profiles[routeName]) {
          const routeProfile = workerRouting.profiles[routeName]
          const resolved = config.provider.providers[routeProfile.provider]
          if (resolved && routeProfile.model === card.model) {
            try {
              if (resolved.auth?.type === 'oauth') {
                const routedAuth = resolved.name === activeProvider.name
                  ? activeAuth
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
              // Provider route is configured but unavailable in this environment.
              // Fall back to the active provider so delegation remains useful.
              workerProvider = activeProvider
              workerApiKey = activeApiKey
              workerAuth = activeAuth
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
        activeClaims: _claimStoreRef?.listActiveClaims() ?? [],
        domainKnowledgeStore,
      }
    }

    _coordinatorRef = new DelegationCoordinator({
      baseToolRegistry: toolRegistry,
      modelCards,
      maxWorkers: 3,
      runtimeFactory,
      routing: workerRouting,
      domainKnowledgeStore,
      modelTierShadowStore: _meridianIndexerRef?.getDb(),
      modelTierBanditEnabled: config.agent.modelTierBanditEnabled === true,
      gatedInfluenceAuditStore: _meridianIndexerRef?.getDb(),
    })

    return new AgentLoop(
      {
        ...agentCfg,
        toolRegistry,
        maxTurns: config.agent.maxTurns,
        getSessionMemoryState: () => persist.getSessionMemoryState(),
        lspEnabled: true,
        lspManager,
        fileHistory,
        contextClaimStore: claimStore,
        playbookStore,
        taskLedger: _taskLedgerRef ?? undefined,
        ownershipLedger: _ownershipLedgerRef ?? undefined,
        meridianIndexer: _meridianIndexerRef,
        modelRoutingShadowModelCards: modelCards,
        domainKnowledgeStore,
      },
      session,
      cwd,
    )
  }, [activeProvider, activeApiKey, activeAuth, currentModel, fileHistory, domainKnowledgeStore])
  agentRef.current = agent

  const allProviders: Record<string, { models: Array<{ id: string; alias: string }> }> = {}
  for (const [name, prov] of Object.entries(config.provider.providers)) {
    allProviders[name] = { models: prov.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })) }
  }

  const availableModels = activeProvider.models.map(m => ({ id: m.id, alias: m.alias ?? m.id }))

  const handleModelSwitch = useCallback((modelId: string): { ok: boolean; error?: string } => {
    for (const [provName, prov] of Object.entries(config.provider.providers)) {
      const found = prov.models.find(m => m.id === modelId || m.alias === modelId)
      if (found) {
        // OAuth providers: check if token is already saved
        if (prov.auth?.type === 'oauth') {
          if (provName !== activeProvider.name) {
            const oauthAuth = createAuthProvider(prov.auth, process.env)
            setActiveProvider(prov)
            setActiveApiKey('')
            setActiveAuth(oauthAuth)
          }
          setCurrentModel(found)
          return { ok: true }
        }
        // API key providers
        const provKey = prov.apiKey ?? process.env[prov.apiKeyEnv ?? '']
        if (!provKey) {
          return { ok: false, error: `API key not set for ${provName}. Set ${prov.apiKeyEnv ?? 'apiKey'} in config or environment.` }
        }
        if (provName !== activeProvider.name) {
          setActiveProvider(prov)
          setActiveApiKey(provKey)
        }
        setCurrentModel(found)
        return { ok: true }
      }
    }
    return { ok: false, error: `Model "${modelId}" not found in any provider.` }
  }, [config.provider.providers, activeProvider.name])

  // Register shutdown callback for signal handlers
  useEffect(() => {
    shutdownCallback = () => {
      // Persist session state FIRST — these synchronous writes are the most
      // valuable work on exit and the most likely to throw (disk full). Do them
      // before any cleanup so state is saved even if a later step fails.
      persist.compactOai(session.getMessages())
      if (_fileHistoryRef) {
        persistFileHistory(
          join(homedir(), '.rivet', 'sessions', sessionId, 'file-history.json'),
          _fileHistoryRef.getAllSnapshots(),
        )
      }
      // Flush debounced stigmergy deposits synchronously — a pheromone deposited
      // within the 200ms debounce window would otherwise be lost on exit.
      agent.flushStigmergySync()
      // agent.abort() already triggers killAll() internally (loop.ts); a second
      // killAll() here is dead on the exit path (its setTimeout SIGKILL never
      // fires before process.exit). gracefulShutdown's killAllSync() does the
      // real synchronous reap. (root-cause analysis 2026-06-05, Thread 1C)
      agent.abort()
      _mcpManager?.shutdown().catch(() => {})
      _meridianIndexerRef?.close()
    }
    return () => { shutdownCallback = null }
  }, [agent, persist, session, sessionId])

  const claimStoreRef = useRef<import('./context/claim-store.js').ContextClaimStore | null>(null)
  claimStoreRef.current = _claimStoreRef

  return createElement(App, {
    agent,
    session,
    persist,
    model: currentModel.alias ?? currentModel.id,
    maxTokens: currentModel.contextWindow,
    currentSessionId: sessionId,
    availableModels,
    onModelSwitch: handleModelSwitch,
    allProviders,
    currentProvider: activeProvider.name,
    initialInput,
    mcpManagerRef,
    claimStoreRef,
    approvalMode: config.agent.approval,
  })
}

/** Read piped stdin (non-TTY only) as initial input */
function readPipedStdin(): string | undefined {
  if (process.stdin.isTTY) return undefined
  try {
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(8192)
    while (true) {
      const bytesRead = readSync(0, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    const input = Buffer.concat(chunks).toString('utf-8').trim()
    return input.length > 0 ? input : undefined
  } catch {
    return undefined
  }
}

async function main() {
  // CLI subcommand routing
  const args = process.argv.slice(2)

  // --help / -h
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`
  Rivet | 铆钉 — coding agent for DeepSeek V4

  Usage:
    rivet              Start interactive session
    rivet --dangerously-skip-permissions  Start with all approval prompts skipped
    rivet config              Configure providers interactively
    rivet --help              Show this help
    rivet --version    Show version
    rivet --goal \"text\"  Autonomous goal loop (--budget N, default 100)

  Commands:
    config show              Show current configuration
    config providers         List configured providers
    config setup <p>         Create/update provider from built-in preset
    config set-url <p> <url> Set provider base URL
    config set-model <p> <m> Set preferred provider model
    config set-key <p> <k>   Set API key for provider <p>
    config set-key-env <p>   Set API key from env var
    config set-default <p>   Set default provider
    config add-model <p>     Add a model to provider
    config remove-model <p>  Remove a model from provider
    config mcp              Manage MCP servers (list, add-stdio, add-sse, remove, enable, disable)

  Slash commands (inside session):
    /help       Show available commands
    /exit       Exit Rivet
    /compact    Compact conversation context
    /model      Switch model (v4-pro / v4-flash)
    /sessions   List saved sessions
    /resume     Restore a previous session
    /clear      Clear screen

  Multi-line input:
    Alt+Enter   Insert newline
    Ctrl+N      Insert newline (fallback)

  Configuration:
    Config file: ~/.rivet/config.json
    Approval:    rivet config set-approval auto-safe|manual|auto-accept|dangerously-skip-permissions
    Sessions:    ~/.rivet/sessions/

  Environment:
    DEEPSEEK_API_KEY   DeepSeek API key (required)
`)
    process.exit(0)
  }

  // --version
  if (args[0] === '--version' || args[0] === '-v') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
    console.log(`rivet v${pkg.version}`)
    process.exit(0)
  }

  // rivet serve [--port N] — HTTP Runtime API
  if (args[0] === 'serve') {
    const portIdx = args.indexOf('--port')
    const port = parseInt(portIdx >= 0 ? args[portIdx + 1]! : '3100', 10)

    const { startServer } = await import('./server/index.js')
    const { createRoutes } = await import('./server/routes.js')

    const apiToken = process.env.RIVET_SERVER_TOKEN?.trim()
    if (!apiToken) {
      console.error('RIVET_SERVER_TOKEN is required for rivet serve')
      process.exit(1)
    }

    const config = loadConfig()
    const provider = config.provider.providers[config.provider.default]
    if (!provider) {
      console.error(`Provider "${config.provider.default}" not configured`)
      process.exit(1)
    }

    let auth: AuthProvider | undefined
    let apiKey = ''
    if (provider.auth?.type === 'oauth') {
      auth = createAuthProvider(provider.auth, process.env, provider.apiKey)
      if (!auth.isAuthenticated()) {
        console.error(`Provider "${provider.name}" OAuth authentication is required before starting the server`)
        process.exit(1)
      }
    } else {
      apiKey = resolveApiKey(provider)
    }

    const model = provider.models[0]
    if (!model) {
      console.error(`Provider "${provider.name}" has no configured models`)
      process.exit(1)
    }

    const activeAgents = new Set<AgentLoop>()
    let activeAgent: AgentLoop | null = null
    const state: import('./server/routes.js').ServerState = {
      running: false,
      apiToken,
      abort: () => {
        for (const agent of activeAgents) agent.abort()
      },
    }
    const routes = createRoutes(state, {
      createAgent: () => {
        const sessionId = randomUUID()
        const persist = new SessionPersist(sessionId)
        const claimStore = persist.createClaimStore()
        persist.injectDurableClaims(claimStore)
        for (const rule of loadProjectRules(process.cwd())) claimStore.propose(rule)
        const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
        const playbookStore = new PlaybookStore(process.cwd())
        const toolRegistry = createDefaultToolRegistry()
        const agentCfg = createAgentConfig(createMainAgentConfigInput({
          apiKey,
          model: { id: model.id, maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort },
          cwd: process.cwd(),
          provider,
          config,
          sessionId,
          toolDefinitions: toolRegistry.getDefinitions(),
          sessionMemoryBlock: persist.buildMemoryBlock(),
          auth,
        }))
        const session = new SessionContext()
        const agent = new AgentLoop({
          ...agentCfg,
          toolRegistry,
          maxTurns: config.agent.maxTurns,
          contextClaimStore: claimStore,
          getSessionMemoryState: () => persist.getSessionMemoryState(),
          fileHistory,
          playbookStore,
        }, session, process.cwd())
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
    const server = startServer(port, routes, apiToken)

    const shutdownServer = () => {
      for (const agent of activeAgents) agent.abort()
      server.close()
      process.exit(0)
    }
    process.on('SIGINT', shutdownServer)
    process.on('SIGTERM', shutdownServer)

    console.log(`Rivet Runtime API listening on http://localhost:${port}`)
    console.log('Endpoints: GET /status, POST /abort, POST /prompt')
    return
  }

  // --worktree flag
  if (args.includes('--worktree')) {
    const { createWorktree, removeWorktree } = await import('./agent/worktree.js')
    const sessionId = crypto.randomUUID()
    const wt = createWorktree(process.cwd(), sessionId)
    const baseCwd = process.cwd()
    process.chdir(wt.path)
    process.on('exit', () => removeWorktree(baseCwd, wt.path, wt.branch))
    process.on('SIGINT', () => { removeWorktree(baseCwd, wt.path, wt.branch); process.exit(0) })
    process.on('SIGTERM', () => { removeWorktree(baseCwd, wt.path, wt.branch); process.exit(0) })
    console.log(`Worktree created at: ${wt.path}`)
  }

  if (args[0] === 'config') {
    await runConfigCLI(args.slice(1))
    return
  }

  // rivet --goal "text" [--budget N] — Autonomous goal loop
  if (args.includes('--goal')) {
    const { parseCliArgs } = await import('./headless.js')
    const { runGoalLoop } = await import('./goal-loop.js')
    const parsed = parseCliArgs(args)
    if (!parsed.goal) {
      console.error('--goal requires a goal description')
      process.exit(2)
    }

    const cfg = loadConfig()
    const prov = cfg.provider.providers[cfg.provider.default]
    if (!prov) { console.error('Provider not configured'); process.exit(1) }
    const key = prov.apiKey ?? process.env[prov.apiKeyEnv ?? '']
    if (!key) { console.error('API key not configured'); process.exit(1) }

    const model = prov.models[0]!
    const sessionId = randomUUID()
    const persist = new SessionPersist(sessionId)
    const claimStore = persist.createClaimStore()
    persist.injectDurableClaims(claimStore)
    for (const rule of loadProjectRules(process.cwd())) {
      claimStore.propose(rule)
    }
    const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
    const playbookStore = new PlaybookStore(process.cwd())

    const result = await runGoalLoop({
      goal: parsed.goal,
      budget: parsed.budget ?? 100,
      createAgent: () => {
        const toolRegistry = createDefaultToolRegistry()

        const agentCfg = createAgentConfig(createMainAgentConfigInput({
          apiKey: key,
          model: { id: model.id, maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort },
          cwd: process.cwd(),
          provider: prov,
          config: cfg,
          sessionId,
          toolDefinitions: toolRegistry.getDefinitions(),
          sessionMemoryBlock: persist.buildMemoryBlock(),
          auth: undefined,
        }))

        const goalCoordinator = new DelegationCoordinator({
          baseToolRegistry: toolRegistry,
          modelCards: [{ model: model.id, toolUseReliability: 0.8, jsonStability: 0.8, editSuccessRate: 0.7, testRepairRate: 0.6, contextWindow: model.contextWindow, cacheEconomics: 'strong', recommendedTasks: ['code_search'] }],
          maxWorkers: 3,
          runtimeFactory: (order, card, workerRegistry) => ({
            order,
            client: createProviderClient(prov, resolveCapabilities(prov.name, prov.capabilities), { apiKey: key, model: card.model, reasoningEffort: undefined, maxTokens: Math.min(4096, card.contextWindow), thinkingBudget: 4096 }),
            promptEngine: new PromptEngine({ model: card.model, maxTokens: 4096, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: process.cwd() } }),
            toolRegistry: workerRegistry,
            cwd: process.cwd(),
            maxTurns: 8,
            contextWindow: card.contextWindow,
            compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
            activeClaims: claimStore.listActiveClaims(),
          }),
        })
        toolRegistry.register(createDelegateTaskTool(
          { delegate: async (req) => goalCoordinator.delegate(req) },
          () => claimStore,
          () => sessionId,
        ))
        toolRegistry.register(createDelegateBatchTool(
          { delegateBatch: async (requests, policy, abortSignal, onProgress) => goalCoordinator.delegateBatch(requests, policy, abortSignal, onProgress) },
          () => claimStore,
          () => sessionId,
        ))

        const session = new SessionContext()
        return new AgentLoop({
          ...agentCfg,
          toolRegistry,
          maxTurns: 25,
          contextClaimStore: claimStore,
          getSessionMemoryState: () => persist.getSessionMemoryState(),
          fileHistory,
          playbookStore,
        }, session, process.cwd())
      },
      checkGoalAchieved: (text: string) => {
        const lower = text.toLowerCase()
        // Require explicit standalone markers — loose substrings like
        // "I haven't achieved the goal yet" or "all tests pass for this module"
        // must not trigger false positives.
        return /\bgoal\s+achieved\b/.test(lower)
          || /\ball\s+tests\s+pass(?:ed)?\s*[.!\n]/.test(lower)
          || /\btask\s+complete[ds]?\s*[.!\n]/.test(lower)
      },
      onIteration: (i, _text, usage) => {
        console.log(`[Goal Loop] Iteration ${i} — ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`)
      },
    })

    console.log(`\n[Goal Loop] ${result.achieved ? '✓ Goal achieved' : '✗ Goal not achieved'}`)
    console.log(`  Iterations: ${result.iterations}`)
    console.log(`  Exit reason: ${result.exitReason}`)
    console.log(`  Total tokens: ${result.totalUsage.input_tokens} in / ${result.totalUsage.output_tokens} out`)
    process.exit(result.achieved ? 0 : 1)
  }

  // rivet -p "prompt" | rivet --print "prompt" [--json] [--stream-json] — Headless one-shot
  if (args.includes('-p') || args.includes('--print')) {
    const { parseCliArgs, runHeadless } = await import('./headless.js')
    const parsed = parseCliArgs(args)
    if (!parsed.prompt) {
      console.error('-p/--print requires a prompt string')
      process.exit(2)
    }

    const cfg = loadConfig()
    const prov = cfg.provider.providers[cfg.provider.default]
    if (!prov) { console.error('Provider not configured'); process.exit(1) }
    const key = prov.apiKey ?? process.env[prov.apiKeyEnv ?? '']
    if (!key) { console.error('API key not configured'); process.exit(1) }

    const model = prov.models[0]!
    const sessionId = randomUUID()

    const result = await runHeadless({
      prompt: parsed.prompt,
      json: parsed.json,
      streamJson: parsed.streamJson,
      createAgent: () => {
        const toolRegistry = createDefaultToolRegistry()
        const agentCfg = createAgentConfig(createMainAgentConfigInput({
          apiKey: key,
          model: { id: model.id, maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort },
          cwd: process.cwd(),
          provider: prov,
          config: cfg,
          sessionId,
          toolDefinitions: toolRegistry.getDefinitions(),
          sessionMemoryBlock: undefined,
          auth: undefined,
        }))

        const session = new SessionContext()
        return new AgentLoop({
          ...agentCfg,
          toolRegistry,
          maxTurns: 15,
          contextClaimStore: undefined,
          getSessionMemoryState: () => undefined,
        }, session, process.cwd())
      },
    })

    if (result.stdout) process.stdout.write(result.stdout + '\n')
    if (result.json) {
      // stdout already contains the JSON in --json mode, skip duplicate
      if (!parsed.json) process.stdout.write(JSON.stringify(result.json) + '\n')
    }
    process.exit(result.exitCode)
  }

  const config = loadConfig()

  // Session Registry: 多实例共存 + 崩溃检测
  const stateDir = join(homedir(), '.rivet', 'state')
  const { SessionRegistry } = await import('./agent/session-registry.js')
  const registry = await SessionRegistry.create(stateDir)
  _sessionRegistryRef = registry

  // 清理崩溃会话 + stale claims
  const crashedSessions = registry.detectCrashedSessions()
  if (crashedSessions.length > 0) {
    console.log(`\n🔄 检测到 ${crashedSessions.length} 个异常退出的会话，已清理`)
    for (const cs of crashedSessions) {
      console.log(`   会话 ID: ${cs.id}`)
    }
  }

  // 尝试恢复最近的崩溃会话
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

  // 注册当前会话
  const sessionId = getOrCreateSessionId()
  registry.register(sessionId, process.cwd())

  // 心跳定时器
  const heartbeatInterval = setInterval(() => {
    try { registry.heartbeat(sessionId) } catch { /* ignore */ }
  }, 10_000).unref()
  _heartbeatInterval = heartbeatInterval

  // 退出时清理
  process.on('exit', () => {
    clearInterval(heartbeatInterval)
    try {
      registry.unregister(sessionId)
      registry.close()
    } catch { /* ignore during exit */ }
  })

  // CLI: --provider <name> --model <id>
  const providerArg = args.indexOf('--provider')
  const modelArg = args.indexOf('--model')
  const requestedProvider = providerArg >= 0 ? args[providerArg + 1] : undefined
  const requestedModel = modelArg >= 0 ? args[modelArg + 1] : undefined

  let provider: ProviderConfig
  if (requestedProvider) {
    const found = config.provider.providers[requestedProvider]
    if (!found) {
      console.error(`Provider "${requestedProvider}" not configured. Available: ${Object.keys(config.provider.providers).join(', ')}`)
      process.exit(1)
    }
    provider = found
  } else {
    provider = config.provider.providers[config.provider.default]!
    if (!provider) {
      console.error(`Provider "${config.provider.default}" not configured`)
      process.exit(1)
    }
  }

  // If --model specified, validate it exists in the selected provider
  if (requestedModel) {
    const found = provider.models.find(m => m.id === requestedModel || m.alias === requestedModel)
    if (!found) {
      console.error(`Model "${requestedModel}" not found in provider "${provider.name}". Available: ${provider.models.map(m => m.id).join(', ')}`)
      process.exit(1)
    }
  }

  // Auth resolution: OAuth providers get an AuthProvider, API key providers get a raw key
  let auth: AuthProvider | undefined
  let apiKey: string

  if (provider.auth?.type === 'oauth') {
    auth = createAuthProvider(provider.auth, process.env, provider.apiKey)
    if (!auth.isAuthenticated()) {
      console.error(`\n[${provider.name}] OAuth authentication required. Opening browser...\n`)
      await auth.authenticate()
      console.error('Authentication successful.\n')
    }
    apiKey = '' // AuthProvider handles headers directly
  } else {
    apiKey = provider.apiKey ?? process.env[provider.apiKeyEnv ?? ''] ?? ''
    if (!apiKey) {
      console.error('API key not configured. Set api_key in config or set environment variable.')
      process.exit(1)
    }
  }

  _pipedInput = readPipedStdin()

  // Prevent MaxPerformanceEntryBufferExceededWarning from Ink's render loop.
  // Ink calls performance.now() on every render, and Node.js accumulates
  // performance entries indefinitely. Clear the buffer periodically.
  const perfCleanup = setInterval(() => {
    try { performance.clearMeasures() } catch { /* noop */ }
  }, 60_000).unref()
  _perfCleanup = perfCleanup

  // Slow render monitor: track event-loop stalls.
  // Ink re-renders run synchronously on the main thread — a long render
  // blocks the event loop. By measuring gaps between interval ticks, we
  // can detect slow renders without needing Ink's internal hooks.
  // Only active in DEV mode to avoid production stderr spam.
  // Only active in DEV mode to avoid production stderr spam.
  // Threshold 500ms: 200ms was too aggressive — normal Ink renders + React
  // hydration easily exceed it, causing continuous log spam on startup.
  // Grace period: skip the first 3 seconds to avoid false positives from
  // initial render, module loading, and prompt engine warmup.
  const SLOW_RENDER_MS = 500
  const SLOW_RENDER_GRACE_MS = 3000
  const SLOW_RENDER_MAX_LOGS = 5
  const monitorStart = Date.now()
  let slowRenderTick = monitorStart + SLOW_RENDER_GRACE_MS
  let slowRenderLogCount = 0
  // Only emit when stderr is NOT an interactive TTY (redirected to a file/pipe).
  // Raw process.stderr.write to a live terminal interleaves with Ink's frame —
  // Ink's patchConsole only intercepts console.*, not raw writes — corrupting
  // logUpdate's line accounting and stranding duplicate frames (e.g. the input
  // bar) in scrollback. Diagnostic is still captured when you run `2>log`.
  const slowRenderMonitor = (process.env.NODE_ENV !== 'production' && !process.stderr.isTTY)
    ? setInterval(() => {
        const now = Date.now()
        const gap = now - slowRenderTick
        slowRenderTick = now
        if (now - monitorStart < SLOW_RENDER_GRACE_MS) return
        if (slowRenderLogCount >= SLOW_RENDER_MAX_LOGS) return
        if (gap > SLOW_RENDER_MS) {
          slowRenderLogCount++
          const ts = new Date(now).toISOString()
          process.stderr.write(`[slow-render] ${ts} gap=${gap}ms (threshold=${SLOW_RENDER_MS}ms)${slowRenderLogCount >= SLOW_RENDER_MAX_LOGS ? ' (silenced, max logs reached)' : ''}\n`)
        }
      }, SLOW_RENDER_MS).unref()
    : undefined

  // Gated diagnostic — no-op unless RIVET_DEBUG_FULLSCREEN=1 AND stderr is
  // redirected to a file/pipe (never writes to an interactive terminal, which
  // would itself corrupt Ink frames). Detects every mechanism that can deposit
  // a stale live frame (ground zone / palette / history) into scrollback:
  //   (1) [fullscreen-clear] — Ink wrote \x1B[2J\x1B[H (live output reached
  //       terminal height → fullscreen re-emit of fullStaticOutput).
  //   (2) [resize-clear] — our registerResizeClear → inkInstance.clear() fired.
  //   (3) [tall-frame] — a single write contained >= rows newlines (a live frame
  //       at/over terminal height — the precondition for fullscreen on next render).
  // Capture with:  RIVET_DEBUG_FULLSCREEN=1 node dist/main.js 2>layout.log
  if (process.env.RIVET_DEBUG_FULLSCREEN === '1' && !process.stderr.isTTY) {
    const origWrite = process.stdout.write.bind(process.stdout)
    let clears = 0
    let tallFrames = 0
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') {
        const rows = process.stdout.rows ?? 0
        if (chunk.includes('\x1B[2J')) {
          clears++
          process.stderr.write(`[fullscreen-clear] #${clears} rows=${rows} cols=${process.stdout.columns} — Ink cleared screen (live output >= terminal height)\n`)
        }
        // A frame whose newline count approaches the viewport is the precondition
        // for the next render tripping fullscreen. Log it so overflow is provable
        // even when the clear itself hasn't fired yet.
        if (rows > 0) {
          let nl = 0
          for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) nl++
          if (nl >= rows - 1) {
            tallFrames++
            process.stderr.write(`[tall-frame] #${tallFrames} lines=${nl} rows=${rows} cols=${process.stdout.columns} — live frame near/over viewport height\n`)
          }
        }
      }
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write
  }

  const inkInstance = render(
    createElement(ErrorBoundary, null, createElement(Root, { provider, apiKey, config, auth, initialModelId: requestedModel })),
    { exitOnCtrlC: false },
  )
  const { waitUntilExit } = inkInstance

  // Ink's resized() only clears the screen on width-DECREASE; on width-increase
  // it diffs the new frame against output computed at the old (narrow) width,
  // where line-wrapping differed, leaving orphaned rows as ghosts (stacked
  // ground zones on grow). Force a full clear on the resize trailing edge for
  // either direction so the next commit redraws onto a clean screen.
  const debugFs = process.env.RIVET_DEBUG_FULLSCREEN === '1' && !process.stderr.isTTY
  let resizeClears = 0
  const unregisterResizeClear = registerResizeClear(() => {
    if (debugFs) {
      resizeClears++
      process.stderr.write(`[resize-clear] #${resizeClears} rows=${process.stdout.rows} cols=${process.stdout.columns} — registerResizeClear fired inkInstance.clear()\n`)
    }
    inkInstance.clear()
  })

  process.on('SIGINT', gracefulShutdown)
  process.on('SIGTERM', gracefulShutdown)
  process.on('SIGHUP', gracefulShutdown)

  await waitUntilExit()
  unregisterResizeClear()
  clearInterval(perfCleanup)
  clearInterval(slowRenderMonitor!)
  // Force-exit: lingering handles (MCP stdio, libuv pool) otherwise keep the
  // event loop alive and leave an orphaned process after the TUI unmounts.
  gracefulShutdown()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
