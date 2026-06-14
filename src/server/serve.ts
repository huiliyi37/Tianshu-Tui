/**
 * `rivet serve` — HTTP+SSE Runtime API entry, extracted from the legacy Ink
 * entry so it ships from the release build (`dist/main.js`). Used directly as a
 * localhost sidecar by 天枢桌面版 (desktop/).
 *
 * Guardrails: binds 127.0.0.1 only; Bearer token fail-closed; reuses the
 * existing AgentLoop / ArtifactStore — no runtime rewrite, only an API surface.
 */
import { randomUUID } from 'node:crypto'
import { startServer } from './index.js'
import { createRoutes, type ServerState } from './routes.js'
import { RuntimeSessionManager } from './session-manager.js'
import { buildSessionRoutes } from './session-routes.js'
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
import { SessionContext } from '../agent/context.js'
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
 * Build a fully-wired AgentLoop for one session rooted at `cwd`. Each call gets
 * its own SessionPersist / claim store / FileHistory / PlaybookStore / tool
 * registry / PromptEngine (via createAgentConfig) and its own ArtifactStore
 * (created internally by AgentLoop, keyed by sessionId) — so concurrent
 * sessions never share prompt cache state or artifacts.
 */
export function buildAgentLoop(ctx: ServeContext, cwd: string): BuiltAgent {
  const sessionId = randomUUID()
  const persist = new SessionPersist(sessionId)
  const claimStore = persist.createClaimStore()
  persist.injectDurableClaims(claimStore)
  for (const rule of loadProjectRules(cwd)) claimStore.propose(rule)
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const playbookStore = new PlaybookStore(cwd)
  const toolRegistry = createDefaultToolRegistry([], { desktopTools: ctx.config.agent.desktopTools })
  const agentCfg = createAgentConfig(createMainAgentConfigInput({
    apiKey: ctx.apiKey,
    model: {
      id: ctx.model.id,
      maxTokens: ctx.model.maxTokens,
      contextWindow: ctx.model.contextWindow,
      reasoningEffort: ctx.model.reasoningEffort,
    },
    cwd,
    provider: ctx.provider,
    config: ctx.config,
    sessionId,
    toolDefinitions: toolRegistry.getDefinitions(),
    sessionMemoryBlock: persist.buildMemoryBlock(),
    auth: ctx.auth,
  }))
  const session = new SessionContext()
  const agent = new AgentLoop({
    ...agentCfg,
    toolRegistry,
    maxTurns: ctx.config.agent.maxTurns,
    contextClaimStore: claimStore,
    getSessionMemoryState: () => persist.getSessionMemoryState(),
    fileHistory,
    playbookStore,
  }, session, cwd)
  return { agent, sessionId }
}

export interface RunServeOptions {
  port?: number
  token?: string
  /** Override the serve context (tests inject a fake). */
  context?: ServeContext
}

export interface RunningServer {
  port: number
  close: () => void
  sessions: RuntimeSessionManager
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

  // Multi-session manager (M0.5): each session is an independent AgentLoop,
  // adapted to the manager's ManagedAgent surface (run/abort + artifacts).
  const sessions = new RuntimeSessionManager({
    createAgent: (cwd) => {
      const { agent } = buildAgentLoop(ctx, cwd ?? process.cwd())
      return {
        run: (prompt, callbacks) => agent.run(prompt, callbacks),
        abort: () => agent.abort(),
        listArtifacts: () => agent.artifactStore?.list() ?? [],
        readArtifact: (artifactId) => agent.artifactStore?.readRaw(artifactId) ?? Promise.resolve(null),
      }
    },
    defaultCwd: process.cwd(),
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

  // Multi-session routes (M0.5 → M3): /sessions/*
  Object.assign(routes, buildSessionRoutes(sessions, apiToken))

  const server = startServer(port, routes, apiToken)
  return {
    port,
    sessions,
    close: () => {
      for (const agent of activeAgents) agent.abort()
      sessions.abortAll()
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
