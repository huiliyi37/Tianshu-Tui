import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { render } from 'ink'
import { createElement, useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { App } from './tui/app.js'
import { ErrorBoundary } from './tui/error-boundary.js'
import { AgentLoop } from './agent/loop.js'
import { createAgentConfig } from './agent/create-agent-config.js'
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
import { createProviderClient } from './api/factory.js'
import { resolveCapabilities } from './api/provider.js'
import { DelegationCoordinator } from './agent/coordinator.js'
import type { WorkerRuntimeFactory } from './agent/coordinator.js'
import type { ModelCapabilityCard } from './model/capability.js'
import { killAll } from './tools/process-tracker.js'
import { configSchema } from './config/schema.js'
import { DEFAULT_CONFIG } from './config/default.js'
import { runConfigCLI } from './config/manager.js'
import { McpManager } from './mcp/manager.js'
import { loadProjectRules } from './context/rules-loader.js'
import { createRecallTool } from './tools/recall.js'
import type { Config, ProviderConfig } from './config/schema.js'

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>)
    } else {
      result[key] = sv
    }
  }
  return result
}

function loadConfig(): Config {
  const configPath = join(homedir(), '.rivet', 'config.json')

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      const merged = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, raw as Record<string, unknown>)
      return configSchema.parse(merged)
    } catch (err) {
      console.error('Config file error, using defaults:', (err as Error).message)
    }
  }

  return configSchema.parse(DEFAULT_CONFIG)
}

function getOrCreateSessionId(): string {
  const dir = join(homedir(), '.rivet')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const id = randomUUID()
  const idFile = join(dir, 'session-id.txt')
  writeFileSync(idFile, id)
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

// Module-level MCP manager reference — initialized in Root, shut down on exit
let _mcpManager: McpManager | null = null

function gracefulShutdown() {
  shutdownCallback?.()
  process.exit(0)
}

function Root({ provider, apiKey, config }: { provider: ProviderConfig; apiKey: string; config: Config }) {
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
      delegateBatch: async (requests, policy) => {
        if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
        return _coordinatorRef.delegateBatch(requests, policy)
      },
    }))
    return reg
  })

  // MCP initialization — discovers tools from configured MCP servers and registers them
  const [, setMcpReady] = useState(false)
  const [toolVersion, setToolVersion] = useState(0)
  const mcpManagerRef = useRef<McpManager | null>(null)

  useEffect(() => {
    if (!config.mcp.enabled || Object.keys(config.mcp.servers).length === 0) {
      setMcpReady(true)
      return
    }

    const mgr = new McpManager(config.mcp)
    _mcpManager = mgr
    mcpManagerRef.current = mgr

    mgr.initialize().then(() => {
      const mcpTools = mgr.getAllTools()
      for (const tool of mcpTools) {
        toolRegistry.register(tool)
      }
      setMcpReady(true)
      setToolVersion(v => v + 1)

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
    }).catch((err) => {
      console.error('[MCP] Initialization failed:', (err as Error).message)
      setMcpReady(true)
    })

    return () => {
      mgr.shutdown().catch(() => {})
      _mcpManager = null
      mcpManagerRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [session] = useState(() => new SessionContext())

  const [sessionId] = useState(() => getOrCreateSessionId())

  // Evict old session files to stay within the session limit
  useState(() => { evictOldSessions(sessionId) })

  const [fileHistory] = useState(() => {
    const fh = new FileHistory(persist.getBackupDir(), sessionId)
    _fileHistoryRef = fh
    return fh
  })

  const [persist] = useState(() => {
    const p = new SessionPersist(sessionId)
    const existingMessages = p.load()
    if (existingMessages.length > 0) {
      session.loadMessages(existingMessages)
    }
    return p
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

  // Register recall tool once (depends on claimStore existing)
  const recallRef = useRef(false)
  if (!recallRef.current) {
    toolRegistry.register(createRecallTool(claimStore, {
      sessionId,
      getTurn: () => session.getTurnCount(),
    }))
    recallRef.current = true
  }

  // Switchable provider + model — changing either recreates client + promptEngine + agent
  const [activeProvider, setActiveProvider] = useState<ProviderConfig>(() => provider)
  const [activeApiKey, setActiveApiKey] = useState(() => apiKey)
  const [currentModel, setCurrentModel] = useState(() => provider.models[0]!)

  const agent = useMemo(() => {
    const compactModelSpec = activeProvider.models.find(m => m.id === config.compact.model || m.alias === config.compact.model)

    const agentCfg = createAgentConfig({
      apiKey: activeApiKey,
      model: { id: currentModel.id, maxTokens: currentModel.maxTokens, contextWindow: currentModel.contextWindow, reasoningEffort: currentModel.reasoningEffort },
      cwd,
      provider: activeProvider,
      compact: config.compact,
      sessionId,
      toolDefinitions: toolRegistry.getDefinitions(),
      compactModel: compactModelSpec ? { id: compactModelSpec.id, maxTokens: compactModelSpec.maxTokens, contextWindow: compactModelSpec.contextWindow, reasoningEffort: compactModelSpec.reasoningEffort } : undefined,
      sessionMemoryBlock: persist.buildMemoryBlock(),
      approvalMode: config.agent.approval as 'auto-accept' | 'auto-safe' | 'manual',
    })

    // --- DelegationCoordinator ---
    const modelCards: ModelCapabilityCard[] = [{
      model: currentModel.id,
      toolUseReliability: 0.8,
      jsonStability: 0.8,
      editSuccessRate: 0.7,
      testRepairRate: 0.6,
      contextWindow: currentModel.contextWindow,
      cacheEconomics: 'strong',
      recommendedTasks: ['code_search'],
    }]

    const runtimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => {
      const writeProfiles = ['patcher', 'verifier']
      const isWrite = writeProfiles.includes(_order.profile)
      return {
        order: _order,
        client: createProviderClient(activeProvider, resolveCapabilities(activeProvider.name, activeProvider.capabilities), {
          apiKey: activeApiKey,
          model: card.model,
          reasoningEffort: undefined,
          maxTokens: isWrite ? Math.min(8192, card.contextWindow) : Math.min(4096, card.contextWindow),
          thinkingBudget: isWrite ? 8192 : 4096,
        }),
        promptEngine: new PromptEngine({
          model: card.model,
          maxTokens: isWrite ? 8192 : 4096,
          staticCtx: { tools: workerRegistry.getDefinitions() },
          volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock() },
        }),
        toolRegistry: workerRegistry,
        cwd,
        maxTurns: isWrite ? 8 : 4,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        activeClaims: _claimStoreRef?.listActiveClaims() ?? [],
      }
    }

    _coordinatorRef = new DelegationCoordinator({
      baseToolRegistry: toolRegistry,
      modelCards,
      maxWorkers: 3,
      runtimeFactory,
    })

    return new AgentLoop(
      {
        ...agentCfg,
        toolRegistry,
        maxTurns: config.agent.maxTurns,
        getSessionMemoryState: () => persist.getSessionMemoryState(),
        lspEnabled: true,
        fileHistory,
        contextClaimStore: claimStore,
      },
      session,
      cwd,
    )
  }, [activeProvider, activeApiKey, currentModel, toolVersion, fileHistory])

  const allProviders: Record<string, { models: Array<{ id: string; alias: string }> }> = {}
  for (const [name, prov] of Object.entries(config.provider.providers)) {
    allProviders[name] = { models: prov.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })) }
  }

  const availableModels = activeProvider.models.map(m => ({ id: m.id, alias: m.alias ?? m.id }))

  const handleModelSwitch = useCallback((modelId: string): { ok: boolean; error?: string } => {
    for (const [provName, prov] of Object.entries(config.provider.providers)) {
      const found = prov.models.find(m => m.id === modelId || m.alias === modelId)
      if (found) {
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
      agent.abort()
      killAll()
      _mcpManager?.shutdown().catch(() => {})
      persist.compact(session.getMessages())
      if (_fileHistoryRef) {
        persistFileHistory(
          join(homedir(), '.rivet', 'sessions', sessionId, 'file-history.json'),
          _fileHistoryRef.getAllSnapshots(),
        )
      }
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
  })
}

/** Read piped stdin (non-TTY only) as initial input */
function readPipedStdin(): string | undefined {
  if (process.stdin.isTTY) return undefined
  try {
    return readFileSync('/dev/stdin', 'utf-8').trim()
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
    rivet config       Manage API keys and model configuration
    rivet --help       Show this help
    rivet --version    Show version
    rivet --goal \"text\"  Autonomous goal loop (--budget N, default 100)

  Commands:
    config show              Show current configuration
    config providers         List configured providers
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

    const state: import('./server/routes.js').ServerState = { running: false }
    const routes = createRoutes(state)
    const server = startServer(port, routes)

    process.on('SIGINT', () => { server.close(); process.exit(0) })
    process.on('SIGTERM', () => { server.close(); process.exit(0) })

    console.log(`Rivet Runtime API listening on http://localhost:${port}`)
    console.log('Endpoints: GET /status, POST /abort')
    return
  }

  // --worktree flag
  if (args.includes('--worktree')) {
    const { createWorktree, removeWorktree } = await import('./agent/worktree.js')
    const sessionId = crypto.randomUUID()
    const wtPath = createWorktree(process.cwd(), sessionId)
    process.chdir(wtPath)
    process.on('exit', () => removeWorktree(process.cwd(), wtPath))
    process.on('SIGINT', () => { removeWorktree(process.cwd(), wtPath); process.exit(0) })
    process.on('SIGTERM', () => { removeWorktree(process.cwd(), wtPath); process.exit(0) })
    console.log(`Worktree created at: ${wtPath}`)
  }

  if (args[0] === 'config') {
    runConfigCLI(args.slice(1))
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
    const compactModelSpec = prov.models.find(m => m.id === cfg.compact.model || m.alias === cfg.compact.model)
    const sessionId = randomUUID()
    const persist = new SessionPersist(sessionId)
    const claimStore = persist.createClaimStore()
    persist.injectDurableClaims(claimStore)
    for (const rule of loadProjectRules(process.cwd())) {
      claimStore.propose(rule)
    }
    const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)

    const result = await runGoalLoop({
      goal: parsed.goal,
      budget: parsed.budget ?? 100,
      createAgent: () => {
        const toolRegistry = createDefaultToolRegistry()

        const agentCfg = createAgentConfig({
          apiKey: key,
          model: { id: model.id, maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort },
          cwd: process.cwd(),
          provider: prov,
          compact: cfg.compact,
          sessionId,
          toolDefinitions: toolRegistry.getDefinitions(),
          compactModel: compactModelSpec ? { id: compactModelSpec.id, maxTokens: compactModelSpec.maxTokens, contextWindow: compactModelSpec.contextWindow, reasoningEffort: compactModelSpec.reasoningEffort } : undefined,
          sessionMemoryBlock: persist.buildMemoryBlock(),
          approvalMode: 'auto-accept',
        })

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
            maxTurns: 4,
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

        const session = new SessionContext()
        return new AgentLoop({
          ...agentCfg,
          toolRegistry,
          maxTurns: 25,
          contextClaimStore: claimStore,
          getSessionMemoryState: () => persist.getSessionMemoryState(),
          fileHistory,
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

  const config = loadConfig()
  const provider = config.provider.providers[config.provider.default]
  if (!provider) {
    console.error(`Provider "${config.provider.default}" not configured`)
    process.exit(1)
  }

  const apiKey = provider.apiKey ?? process.env[provider.apiKeyEnv ?? '']
  if (!apiKey) {
    console.error('API key not configured. Set api_key in config or set environment variable.')
    process.exit(1)
  }

  _pipedInput = readPipedStdin()

  const { waitUntilExit } = render(
    createElement(ErrorBoundary, null, createElement(Root, { provider, apiKey, config })),
    { exitOnCtrlC: false },
  )

  process.on('SIGINT', gracefulShutdown)
  process.on('SIGTERM', gracefulShutdown)

  await waitUntilExit()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
