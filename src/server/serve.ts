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
import { buildSessionRoutes } from './session-routes.js'
import { buildHealthRoute } from './health-route.js'
import { LoopHealthMonitor } from './loop-health.js'
import { buildScheduleRoutes } from './schedule-routes.js'
import { buildTaskRoutes } from './task-routes.js'
import { buildConfigRoutes } from './config-routes.js'
import { buildEnvRoute } from './env-route.js'
import { buildProjectTemplatesRoutes } from './project-templates-routes.js'
import { buildProjectDocsRoutes } from './project-docs-routes.js'
import { CronScheduler } from './cron-scheduler.js'
import { CronWiring } from './cron-wiring.js'
import { buildMcpRoutes } from './mcp-api.js'
import { buildPluginRoutes } from './plugin-api.js'
import { CronLock } from './cron-lock.js'
import { TaskRegistry } from './task-registry.js'
import { JsonTaskStore } from './task-store.js'
import { SessionRuntimePool } from './session-runtime-pool.js'
import { loadConfig } from '../config/manager.js'
import { isProFeatureEnabled } from '../config/pro-license.js'
import { setTargetConventions, applyConfiguredGitBashPath } from '../platform.js'
import { resolveApiKey } from '../api/factory.js'
import type { OaiMessage } from '../api/oai-types.js'
import { createAuthProvider } from '../auth/registry.js'
import type { AuthProvider } from '../auth/types.js'
import { SessionPersist } from '../agent/session-persist.js'
import { SessionContext } from '../agent/context.js'
import { buildOpenPathCommand, buildRevealCommand } from '../tools/open-path.js'
import { SessionRegistry } from '../agent/session-registry.js'
import { ProviderHealthTracker } from '../agent/provider-health.js'
import type { Config, ProviderConfig, ModelConfig } from '../config/schema.js'
import { FileSessionPersistence } from './session-persistence.js'
import type { SharedRuntime } from './serve-agent.js'

type ServeAgentModule = typeof import('./serve-agent.js')
let serveAgentMod: ServeAgentModule | null = null
let serveAgentPromise: Promise<ServeAgentModule> | null = null

/** Load heavy agent assembly (deferred from cold /health path). */
export function loadServeAgent(): Promise<ServeAgentModule> {
  if (!serveAgentPromise) {
    const t0 = performance.now()
    serveAgentPromise = import('./serve-agent.js').then((m) => {
      serveAgentMod = m
      if (process.env.RIVET_SERVE_TIMING === '1') {
        console.error(`[serve-timing] serve-agent import ${Math.round(performance.now() - t0)}ms`)
      }
      return m
    }).catch((err) => {
      // Don't cache a rejected promise — transient build/load failures would
      // permanently break session creation otherwise.
      serveAgentPromise = null
      throw err
    })
  }
  return serveAgentPromise
}

export function _resetServeAgentForTests(): void {
  serveAgentMod = null
  serveAgentPromise = null
}

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
  applyConfiguredGitBashPath(config.env.gitBashPath)
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
      // NOTE (crash-restart resilience): a respawned sidecar re-reads config
      // from disk, so an INLINE `apiKey` survives a restart, but an `apiKeyEnv`
      // key only survives if the shell re-injects that env var into the new
      // process. When it doesn't, we land here with configured=false and every
      // session run would 401 — isModelSpecUsable()/unconfiguredSpecMessage()
      // turn that into a legible error instead of an opaque upstream 401.
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
      // Always adopt the freshly-resolved key — also for the snapshot's own
      // provider. Keeping `ctx.apiKey` there returned an EMPTY key whenever the
      // server started unconfigured and the key arrived later (env/config),
      // making the resolved spec unusable even though provKey was right here.
      provider = prov
      apiKey = provKey
      auth = undefined
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
 * Restore prior OAI conversation messages from disk into a SessionContext.
 *
 * Mirrors the TUI bootstrap path (`persist.loadOai()` + `replaceMessages()`):
 * when the Rust shell spawns a fresh sidecar, RuntimeSessionManager rehydrates
 * session records + event logs from disk, but the agent's LLM message stack
 * lives in a separate file (`~/.rivet/sessions/<slug>/<id>.jsonl`). Without
 * this call, a user continuing a prior session after restart sees full UI
 * history (from the event log) but the model receives an empty context.
 *
 * For brand-new sessions the file doesn't exist yet → loadOai() returns [] →
 * no-op. Called once per session in buildSessionStores, before the mutation
 * listener is wired (so replaceMessages doesn't trigger a redundant disk write).
 */
export interface HistoryRestoreInfo {
  /** Number of prior OAI messages loaded into the context (0 = none/new session). */
  restored: number
  /** Set when the session file existed but could not be read at all (IO error). */
  error?: string
}

export function restoreHistoryMessages(
  persist: SessionPersist,
  session: SessionContext,
): HistoryRestoreInfo {
  // loadOai already skips corrupt lines; the catch covers hard IO failures
  // (unreadable file, permissions) so a broken history file degrades to an
  // empty-context session instead of making the session unbuildable. The
  // caller surfaces the mismatch (UI has history / model has none) to the user.
  let messages: OaiMessage[]
  try {
    messages = persist.loadOai()
  } catch (err) {
    return { restored: 0, error: (err as Error)?.message ?? String(err) }
  }
  if (messages.length > 0) {
    session.replaceMessages(messages)
  }
  return { restored: messages.length }
}

export function isModelSpecUsable(spec: ResolvedModelSpec): boolean {
  return spec.apiKey !== '' || !!spec.auth
}

/** Actionable message when a session is asked to run without a usable key —
 *  shown instead of letting the request hit the provider and 401. */
export function unconfiguredSpecMessage(spec: ResolvedModelSpec): string {
  const provider = spec.provider.name
  const envHint = spec.provider.apiKeyEnv
    ? ` The provider is configured to read its key from the \`${spec.provider.apiKeyEnv}\` environment variable, which is not set in this process (a common cause after a sidecar restart). Set it and relaunch, or store the key inline via Settings.`
    : ' Configure it in Settings (or run `rivet config setup`).'
  return `No usable API key for provider "${provider}" — the request was not sent.${envHint}`
}


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
export async function runServe(opts: RunServeOptions = {}): Promise<RunningServer> {
  const apiToken = (opts.token ?? process.env.RIVET_SERVER_TOKEN)?.trim()
  if (!apiToken) {
    throw new Error('RIVET_SERVER_TOKEN is required for rivet serve')
  }
  const port = opts.port ?? 3100
  const ctx = opts.context ?? resolveServeContext()
  // Hot credential pickup: sessions created after a Settings edit must resolve
  // the CURRENT on-disk key, not the startup snapshot's. Only wired when the
  // context came from disk — an injected context (tests) stays deterministic.
  const specReload = opts.context ? undefined : resolveServeContext
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
    meridianIndexers: new Map(),
    lspManagers: new Map(),
    sameCwdRunningCount: null,
    mcpManager: null,
    sessions: null,
  }

  // Initialize MCP manager asynchronously — dynamic import keeps the MCP SDK
  // out of the cold /health import graph. Fire-and-forget so listen isn't blocked.
  // Use live loadConfig().mcp (not the startup ctx snapshot) so servers added
  // while this IIFE is still loading are not lost; reconcileFromConfig after
  // initialize() picks up anything POSTed before mgr was assigned.
  void (async () => {
    try {
      const { McpManager } = await import('../mcp/manager.js')
      const liveMcp = loadConfig().mcp
      const mgr = new McpManager(liveMcp)
      await mgr.initialize()
      // Race heal: POST /mcp/servers while mgr was null already wrote disk —
      // reconnect anything missing from the in-memory states.
      const reconciled = await mgr.reconcileFromConfig(loadConfig().mcp)
      sharedRuntime.mcpManager = mgr
      if (reconciled.length > 0) {
        sharedRuntime.sessions?.injectMcpTools(reconciled)
      } else if (mgr.getAllTools().length > 0) {
        // Sessions created during init may have missed the first tool snapshot.
        sharedRuntime.sessions?.injectMcpTools(mgr.getAllTools())
      }
      serverLogger.warn(`MCP: ${mgr.getStates().filter(s => s.status === 'connected').length} servers connected, ${mgr.getAllTools().length} tools`)
    } catch (err) {
      serverLogger.warn('MCP initialization failed:', { error: (err as Error)?.message ?? String(err) })
    }
  })()

  // Multi-session manager (M0.5): each session is an independent AgentLoop,
  // adapted to the manager's ManagedAgent surface (run/abort + artifacts). The
  // manager's session id is threaded into buildAgentLoop so the agent's stores
  // align with the session. Agent assembly is dynamically imported (Wave C) so
  // cold /health does not pay for tools/Meridian/council.
  const sessions = new RuntimeSessionManager({
    createAgent: async (cwd, sessionId, approvalMode, modelId) => {
      const agentMod = await loadServeAgent()
      return agentMod.buildManagedAgent(
        ctx,
        cwd ?? process.cwd(),
        sessionId ?? randomUUID(),
        sessionRegistry,
        approvalMode,
        sharedRuntime,
        specReload,
        modelId,
      )
    },
    defaultCwd: process.cwd(),
    persistence,
    // R1 — late-bound getter: registry resolves async after server start.
    getSessionRegistry: () => sessionRegistry,
    // PlusMenu — provider model source + default for the model picker.
    // Reload-aware: picks up providers configured after startup (no restart).
    listModels: () => listAllModelsWithReload(ctx),
    defaultModelId: ctx.model.id,
    defaultDomain: ctx.config.agent?.defaultDomain,
    // 一键续跑兜底模型（可选，用户显式配置）。未配置时原模型不可用的续跑
    // fail-closed —— 绝不静默回退默认模型（跨模型续跑会重建整条前缀缓存）。
    resumeFallbackModel: ctx.config.agent?.resumeFallbackModel,
  })

  // Wave F: sessions 现已就绪——把真实 sameCwdRunningCount 回写到 SharedRuntime。
  // 之后任何 buildManagedAgent → buildSessionStores 创建的 refs.getSameCwdRunningSessions
  // 都会读到这条真实值；verificationSnapshotManager 的多 session 冲突检测真正生效。
  sharedRuntime.sameCwdRunningCount = (cwd, excludeSessionId) =>
    sessions.sameCwdRunningCount(cwd, excludeSessionId)
  // I4: sessions 就绪后回写，让 user hooks 能把结果推送到桌面事件流。
  sharedRuntime.sessions = sessions

  // Legacy single-prompt path (M0): one-shot POST /prompt SSE.
  //
  // Rebased onto RuntimeSessionManager so BOTH prompt paths share one execution
  // model and one disconnect semantic (a dropped connection never aborts; abort
  // is always explicit). Each POST /prompt materializes a real session — its
  // events persist, show up in /sessions, and survive a client disconnect. The
  // dedicated per-run AgentLoop set this path used to maintain is gone with it.
  const activeLegacyRuns = new Set<string>()
  const state: ServerState = {
    running: false,
    apiToken,
    abort: () => {
      sessions.abortAll()
    },
  }

  const routes = createRoutes(state, {
    startPrompt: (prompt) => {
      const rec = sessions.createSession({
        title: prompt.trim().slice(0, 80),
      })
      activeLegacyRuns.add(rec.id)
      state.running = true
      state.sessionId = rec.id
      // Adapter-owned subscription, independent of the streaming one (which
      // dies with the client connection): keeps /status bookkeeping honest and
      // preserves the legacy auto-deny approval semantics — a one-shot client
      // speaks no intervention protocol, so a dangling approval would hang the
      // run until timeout (or forever when no timeout is configured).
      const adminUnsub = sessions.subscribe(rec.id, (ev) => {
        if (ev.type === 'approval_required' && typeof ev.data.requestId === 'string') {
          sessions.answerIntervention(rec.id, ev.data.requestId, 'deny')
        } else if (ev.type === 'done') {
          adminUnsub?.()
          activeLegacyRuns.delete(rec.id)
          state.running = activeLegacyRuns.size > 0
          state.sessionId = activeLegacyRuns.values().next().value
        }
      })
      return {
        sessionId: rec.id,
        subscribe: (listener) => sessions.subscribe(rec.id, listener),
        start: () => sessions.run(rec.id, prompt),
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

  // Project docs route: read/write AGENTS.md / .rivet.md for the desktop settings UI.
  Object.assign(routes, buildProjectDocsRoutes(apiToken))

  // MCP routes: server management + live status for the desktop MCP settings UI.
  Object.assign(routes, buildMcpRoutes({
    getMcpManager: () => sharedRuntime.mcpManager,
    onToolsReady: (tools) => sharedRuntime.sessions?.injectMcpTools(tools),
    apiToken,
  }))

  // Plugin routes: presets + install/enable/remove for desktop plugin market UI.
  Object.assign(routes, buildPluginRoutes(apiToken))

  // Open file in system editor / reveal in file manager — thin wrapper so the
  // Desktop webview can request the sidecar to open a local path without
  // needing a Tauri plugin.
  routes['POST /open-file'] = async (body) => {
    const filePath = (body as Record<string, unknown>)?.path
    if (typeof filePath !== 'string' || !filePath) {
      return { status: 400, body: { error: 'Missing path' } }
    }
    const reveal = (body as Record<string, unknown>)?.reveal === true
    // 路径存在性检查——不静默吞错（之前 spawn error 被 () => {} 吞掉，用户看不到失败）。
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    const { resolve: resolvePath } = require('node:path') as typeof import('node:path')
    const resolved = resolvePath(filePath)
    if (!existsSync(resolved)) {
      return { status: 404, body: { error: `Path not found: ${resolved}` } }
    }
    // Pass `resolved` (not raw `filePath`): when cwd is empty the frontend may
    // send a relative path, which would make explorer /select,<rel> silently
    // fail. builder 接收绝对路径后，win32 分支还会把正斜杠归一为反斜杠。
    const command = reveal ? buildRevealCommand(resolved) : buildOpenPathCommand(resolved)
    // Await spawn 的 spawn/error 事件再返回——之前 fire-and-forget 立即返 200，
    // spawn 失败只进 stderr 日志，前端永远收不到，用户看到"点了没反应"。
    // detached + unref 保持：不阻塞 sidecar 退出。spawn 通常 <50ms。
    try {
      const { spawn } = await import('node:child_process')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' })
        child.on('error', reject)
        child.on('spawn', () => { child.unref(); resolve() })
      })
      return { status: 200, body: { opened: resolved } }
    } catch (err) {
      console.error(`[open-file] spawn failed: ${command.cmd} ${command.args.join(' ')} → ${(err as Error).message}`)
      return { status: 500, body: { error: `启动失败: ${(err as Error).message}` } }
    }
  }

  // N1: GET /health — sidecar liveness for the desktop crash-reconnect banner.
  // RIVET_VERSION is injected at build time via tsup define (tsup.config.ts) so
  // the packaged sidecar reports the real version. Falls back to
  // npm_package_version (CLI `npm start` dev) then a placeholder.
  const version = process.env.RIVET_VERSION ?? process.env.npm_package_version ?? '0.0.0-dev'
  // Event-loop lag telemetry: lets the desktop label a starved loop as
  // "service busy" instead of a phantom "connection interrupted".
  const loopHealth = new LoopHealthMonitor()
  loopHealth.start()
  // registryOk lets the desktop tell "sidecar up but concurrency dormant" apart
  // from a healthy sidecar. In ephemeral/test mode (no registry wired) it reads
  // true so existing single-session behavior is unchanged.
  Object.assign(
    routes,
    buildHealthRoute(sessions, startedAt, version, apiToken, () =>
      opts.ephemeral ? true : sessionRegistry !== undefined,
    () => resolveServeContext().configured,
    () => loopHealth.snapshot(),
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
    Object.assign(routes, buildScheduleRoutes(scheduler, apiToken, {
      getStatus: () => wiring?.getStatus(),
      // 付费版 v1 · T5 — 非 always-review / 含 computer_use 的定时任务归 Pro。
      // 用启动时的 ctx.config：Pro 状态经 RIVET_PRO 注入，激活后本就要求重启 sidecar。
      isUnattendedAutomationEnabled: () =>
        isProFeatureEnabled(ctx.config, 'unattendedAutomation'),
    }))
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

  const listenT0 = performance.now()
  const server = await startServer(port, routes, apiToken)
  if (process.env.RIVET_SERVE_TIMING === '1') {
    console.error(`[serve-timing] listen ready ${Math.round(performance.now() - listenT0)}ms (since runServe start ${Date.now() - startedAt}ms)`)
  }
  // Warm the agent-assembly chunk in the background so the first session
  // doesn't pay the full dynamic-import tax on the critical path.
  void loadServeAgent()
  return {
    port,
    sessions,
    scheduler,
    shared: sharedRuntime,
    close: () => {
      // Legacy /prompt runs live on manager sessions too — abortAll covers both.
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
      // Wave G: 释放 per-cwd 共享 Meridian/LSP 资源（module may still be loading).
      if (serveAgentMod) {
        serveAgentMod.disposeSharedCwdResources(sharedRuntime)
      } else {
        sharedRuntime.meridianIndexers.clear()
        sharedRuntime.lspManagers.clear()
        sharedRuntime.domainStores.clear()
      }
      loopHealth.stop()
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
export async function serveCommand(args: string[]): Promise<void> {
  const portIdx = args.indexOf('--port')
  const port = parseInt(portIdx >= 0 ? args[portIdx + 1]! : '3100', 10)

  let server: RunningServer
  try {
    server = await runServe({ port })
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
