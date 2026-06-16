/**
 * `rivet serve` — HTTP+SSE Runtime API entry, extracted from the legacy Ink
 * entry so it ships from the release build (`dist/main.js`). Used directly as a
 * localhost sidecar by 天枢桌面版 (desktop/).
 *
 * Guardrails: binds 127.0.0.1 only; Bearer token fail-closed; reuses the
 * existing AgentLoop / ArtifactStore — no runtime rewrite, only an API surface.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './index.js'
import { createRoutes, type ServerState } from './routes.js'
import { RuntimeSessionManager } from './session-manager.js'
import { FileSessionPersistence } from './session-persistence.js'
import { buildSessionRoutes } from './session-routes.js'
import { buildHealthRoute } from './health-route.js'
import { buildScheduleRoutes } from './schedule-routes.js'
import { CronScheduler } from './cron-scheduler.js'
import { CronWiring } from './cron-wiring.js'
import { CronLock } from './cron-lock.js'
import { TaskRegistry } from './task-registry.js'
import { JsonTaskStore } from './task-store.js'
import { SessionRuntimePool } from './session-runtime-pool.js'
import { loadConfig } from '../config/manager.js'
import { resolveApiKey } from '../api/factory.js'
import { createAuthProvider } from '../auth/registry.js'
import type { AuthProvider } from '../auth/types.js'
import { SessionPersist } from '../agent/session-persist.js'
import { FileHistory } from '../agent/file-history.js'
import { PlaybookStore } from '../agent/playbook-store.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { createAgentConfig, createMainAgentConfigInput } from '../agent/create-agent-config.js'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
import { AgentLoop } from '../agent/loop.js'
import type { ApprovalMode } from '../agent/loop-types.js'
import { SessionContext } from '../agent/context.js'
import { SessionRegistry } from '../agent/session-registry.js'
import { createTaskLedger } from '../agent/task-ledger.js'
import { createOwnershipLedger } from '../agent/ownership-ledger.js'
import { createWorktreeBaseline } from '../agent/worktree-baseline.js'
import { captureGitBaseline } from '../bootstrap.js'
import type { Config, ProviderConfig, ModelConfig } from '../config/schema.js'

export interface ServeContext {
  config: Config
  provider: ProviderConfig
  model: ModelConfig
  apiKey: string
  auth?: AuthProvider
}

/**
 * Resolve provider/model/auth/apiKey once at server start. Throws a descriptive
 * Error (caught by the CLI entry) when the runtime is not configured.
 */
export function resolveServeContext(loader: () => Config = loadConfig): ServeContext {
  const config = loader()
  const provider = config.provider.providers[config.provider.default]
  if (!provider) {
    throw new Error(`Provider "${config.provider.default}" not configured`)
  }

  let auth: AuthProvider | undefined
  let apiKey = ''
  if (provider.auth?.type === 'oauth') {
    auth = createAuthProvider(provider.auth, process.env, provider.apiKey)
    if (!auth.isAuthenticated()) {
      throw new Error(`Provider "${provider.name}" OAuth authentication is required before starting the server`)
    }
  } else {
    apiKey = resolveApiKey(provider)
  }

  const model = provider.models[0]
  if (!model) {
    throw new Error(`Provider "${provider.name}" has no configured models`)
  }

  return { config, provider, model, apiKey, auth }
}

export interface BuiltAgent {
  agent: AgentLoop
  sessionId: string
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
 * Per-session, model-independent pieces. Built once and reused across model
 * rebuilds so switchModel preserves conversation (same SessionContext) and
 * shared stores (claims/file-history/playbook/tools/ledgers).
 */
interface SessionStores {
  persist: SessionPersist
  claimStore: ReturnType<SessionPersist['createClaimStore']>
  fileHistory: FileHistory
  playbookStore: PlaybookStore
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  session: SessionContext
  taskLedger: ReturnType<typeof createTaskLedger>
  ownershipLedger: ReturnType<typeof createOwnershipLedger>
}

function buildSessionStores(ctx: ServeContext, cwd: string, sessionId: string): SessionStores {
  const persist = new SessionPersist(sessionId)
  const claimStore = persist.createClaimStore()
  persist.injectDurableClaims(claimStore)
  for (const rule of loadProjectRules(cwd)) claimStore.propose(rule)
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const playbookStore = new PlaybookStore(cwd)
  const toolRegistry = createDefaultToolRegistry([], {
    desktopTools: ctx.config.agent.desktopTools,
    browserTool: process.env.RIVET_BROWSER_ENABLED === '1',
  })
  const session = new SessionContext()
  const taskLedger = createTaskLedger({ taskId: sessionId })
  const ownershipLedger = createOwnershipLedger({
    baseline: createWorktreeBaseline(captureGitBaseline(cwd)),
    taskLedger,
  })
  return { persist, claimStore, fileHistory, playbookStore, toolRegistry, session, taskLedger, ownershipLedger }
}

/**
 * Assemble an AgentLoop from prebuilt session stores + a resolved model spec.
 * Reusing `stores.session` across calls is what lets switchModel hot-swap the
 * model while keeping the conversation history intact.
 */
function assembleAgentLoop(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  stores: SessionStores,
  spec: ResolvedModelSpec,
  approvalMode: ApprovalMode | undefined,
  registry?: SessionRegistry,
): AgentLoop {
  const agentCfg = createAgentConfig(createMainAgentConfigInput({
    apiKey: spec.apiKey,
    model: {
      id: spec.model.id,
      maxTokens: spec.model.maxTokens,
      contextWindow: spec.model.contextWindow,
      reasoningEffort: spec.model.reasoningEffort,
    },
    cwd,
    provider: spec.provider,
    config: ctx.config,
    sessionId,
    toolDefinitions: stores.toolRegistry.getDefinitions(),
    sessionMemoryBlock: stores.persist.buildMemoryBlock(),
    auth: spec.auth,
  }))
  if (approvalMode) agentCfg.approvalMode = approvalMode
  return new AgentLoop({
    ...agentCfg,
    toolRegistry: stores.toolRegistry,
    maxTurns: ctx.config.agent.maxTurns,
    contextClaimStore: stores.claimStore,
    getSessionMemoryState: () => stores.persist.getSessionMemoryState(),
    fileHistory: stores.fileHistory,
    playbookStore: stores.playbookStore,
    sessionRegistry: registry,
    taskLedger: stores.taskLedger,
    ownershipLedger: stores.ownershipLedger,
  }, stores.session, cwd)
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
export function buildAgentLoop(
  ctx: ServeContext,
  cwd: string,
  sessionId: string = randomUUID(),
  registry?: SessionRegistry,
  approvalMode?: ApprovalMode,
): BuiltAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId)
  const spec: ResolvedModelSpec = {
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    model: {
      id: ctx.model.id,
      maxTokens: ctx.model.maxTokens,
      contextWindow: ctx.model.contextWindow,
      reasoningEffort: ctx.model.reasoningEffort,
    },
  }
  const agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry)
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
): import('./session-manager.js').ManagedAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId)
  let spec: ResolvedModelSpec = {
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    model: {
      id: ctx.model.id,
      maxTokens: ctx.model.maxTokens,
      contextWindow: ctx.model.contextWindow,
      reasoningEffort: ctx.model.reasoningEffort,
    },
  }
  let agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry)
  return {
    run: (prompt, callbacks) => agent.run(prompt, callbacks),
    abort: () => agent.abort(),
    setApprovalMode: (mode) => agent.setApprovalMode(mode),
    enterPlanMode: () => agent.enterPlanMode(),
    exitPlanMode: () => agent.exitPlanMode(),
    setActivePlan: (plan) => agent.setActivePlan(plan),
    listArtifacts: () => agent.artifactStore?.list() ?? [],
    readArtifact: (artifactId) => agent.artifactStore?.readRaw(artifactId) ?? Promise.resolve(null),
    getMessages: () => agent.session.getMessages(),
    replaceMessages: (msgs) => agent.session.replaceMessages(msgs),
    rewindToMessages: (msgs) => agent.session.rewindToMessages(msgs),
    // PlusMenu — star domain (delegate to the live agent).
    setSessionDomain: (domain) => agent.setSessionDomain(domain),
    resetSessionDomain: () => agent.resetSessionDomain(),
    getSessionDomain: () => agent.getSessionDomain(),
    // PlusMenu — skills (per-session discovery filter on the live agent).
    setDisabledSkills: (names) => agent.setDisabledSkills(names),
    // PlusMenu — model hot-switch (rebuild on the same SessionContext).
    switchModel: (modelId) => {
      const next = resolveModelSpec(ctx, modelId)
      if (!next) return null
      spec = next
      agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry)
      return spec.model.id
    },
  }
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
    const registryDir = process.env.RIVET_DESKTOP_DIR ?? join(homedir(), '.rivet', 'desktop')
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
        opts.sessionDir ??
          process.env.RIVET_DESKTOP_SESSION_DIR ??
          join(homedir(), '.rivet', 'desktop', 'sessions'),
      )

  // Multi-session manager (M0.5): each session is an independent AgentLoop,
  // adapted to the manager's ManagedAgent surface (run/abort + artifacts). The
  // manager's session id is threaded into buildAgentLoop so the agent's stores
  // align with the session.
  const sessions = new RuntimeSessionManager({
    createAgent: (cwd, sessionId, approvalMode) =>
      buildManagedAgent(ctx, cwd ?? process.cwd(), sessionId ?? randomUUID(), sessionRegistry, approvalMode),
    defaultCwd: process.cwd(),
    persistence,
    // R1 — late-bound getter: registry resolves async after server start.
    getSessionRegistry: () => sessionRegistry,
    // PlusMenu — provider model source + default for the model picker.
    listModels: () => listAllModels(ctx),
    defaultModelId: ctx.model.id,
  })

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
      const { agent, sessionId } = buildAgentLoop(ctx, process.cwd())
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
  Object.assign(routes, buildSessionRoutes(sessions, apiToken, () => sessionRegistry))

  // N1: GET /health — sidecar liveness for the desktop crash-reconnect banner.
  const version = process.env.npm_package_version ?? '2.9.0'
  // registryOk lets the desktop tell "sidecar up but concurrency dormant" apart
  // from a healthy sidecar. In ephemeral/test mode (no registry wired) it reads
  // true so existing single-session behavior is unchanged.
  Object.assign(
    routes,
    buildHealthRoute(sessions, startedAt, version, apiToken, () =>
      opts.ephemeral ? true : sessionRegistry !== undefined,
    ),
  )

  // N3: async orchestration — cron scheduler → task registry → runtime pool that
  // spins up *visible* sessions. Disabled in ephemeral mode (tests) to avoid
  // leaking timers.
  let scheduler: CronScheduler | undefined
  let wiring: CronWiring | undefined
  if (!opts.ephemeral) {
    const rivetDir = process.env.RIVET_DESKTOP_DIR ?? join(homedir(), '.rivet', 'desktop')
    scheduler = new CronScheduler({ schedulePath: join(rivetDir, 'scheduled_tasks.json') })
    const registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(rivetDir, 'tasks')) })
    const runtimePool = new SessionRuntimePool({ manager: sessions, defaultCwd: process.cwd() })
    // CronLock: with multiple sidecars pointed at the same desktop dir, exactly
    // one wins the lock and runs the scheduler — the rest stay idle instead of
    // double-firing every scheduled task.
    const lock = new CronLock({ lockPath: join(rivetDir, 'scheduled_tasks.lock') })
    wiring = new CronWiring({ scheduler, registry, runtimePool, lock })
    void wiring.start().catch(() => { /* non-fatal: scheduler stays idle */ })
    Object.assign(routes, buildScheduleRoutes(scheduler, apiToken))
  }

  const server = startServer(port, routes, apiToken)
  return {
    port,
    sessions,
    scheduler,
    close: () => {
      for (const agent of activeAgents) agent.abort()
      sessions.abortAll()
      void wiring?.stop()
      wiring?.dispose()
      scheduler?.stop()
      server.close()
    },
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
  process.on('SIGINT', shutdownServer)
  process.on('SIGTERM', shutdownServer)

  console.log(`Rivet Runtime API listening on http://localhost:${port}`)
  console.log('Endpoints: GET /status, POST /abort, POST /prompt, /sessions/*')
}
