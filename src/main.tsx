import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { render } from 'ink'
import { createElement, useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { App } from './tui/app.js'
import { ErrorBoundary } from './tui/error-boundary.js'
import { AgentLoop } from './agent/loop.js'
import { SessionContext } from './agent/context.js'
import { SessionPersist } from './agent/session-persist.js'
import { PromptEngine } from './prompt/engine.js'
import { ToolRegistry } from './tools/registry.js'
import { createDefaultToolRegistry } from './tools/default-registry.js'
import { createDelegateTaskTool, type DelegateTaskCoordinator } from './tools/delegate-task.js'
import { createDeepSeekClient } from './api/deepseek.js'
import { DelegationCoordinator } from './agent/coordinator.js'
import type { WorkerRuntimeFactory } from './agent/coordinator.js'
import type { ModelCapabilityCard } from './model/capability.js'
import { killAll } from './tools/process-tracker.js'
import { configSchema } from './config/schema.js'
import { DEFAULT_CONFIG } from './config/default.js'
import { runConfigCLI } from './config/manager.js'
import { McpManager } from './mcp/manager.js'
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
    reg.register(createDelegateTaskTool({
      delegate: async (request) => {
        if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
        return _coordinatorRef.delegate(request)
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

  const [persist] = useState(() => {
    const p = new SessionPersist(sessionId)
    const existingMessages = p.load()
    if (existingMessages.length > 0) {
      session.loadMessages(existingMessages)
    }
    return p
  })

  // Switchable model — changing this recreates client + promptEngine + agent
  const [currentModel, setCurrentModel] = useState(() => provider.models[0]!)

  const agent = useMemo(() => {
    const promptEngine = new PromptEngine({
      model: currentModel.id,
      maxTokens: currentModel.maxTokens,
      staticCtx: { tools: toolRegistry.getDefinitions() },
      volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock() },
    })
    const client = createDeepSeekClient({
      apiKey,
      model: currentModel.id,
      reasoningEffort: currentModel.reasoningEffort,
      maxTokens: currentModel.maxTokens,
      thinkingBudget: currentModel.reasoningEffort === 'max' ? 64000 : Math.min(16000, Math.floor(currentModel.contextWindow * 0.02)),
    })

    // Create a compact client for LLM-based summarization (auto-compaction)
    const compactModel = provider.models.find(m => m.id === config.compact.model || m.alias === config.compact.model)
    const compactClient = compactModel ? createDeepSeekClient({
      apiKey,
      model: compactModel.id,
      reasoningEffort: compactModel.reasoningEffort,
      maxTokens: Math.min(2048, compactModel.maxTokens),
      thinkingBudget: 1024,
    }) : undefined

    // --- P2.4: DelegationCoordinator ---
    // Phase 1 uses a single model card; recommendModelForTask trivially picks it.
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

    const runtimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => ({
      order: _order,
      client: createDeepSeekClient({
        apiKey,
        model: card.model,
        reasoningEffort: undefined,
        maxTokens: Math.min(4096, card.contextWindow),
        thinkingBudget: 4096,
      }),
      promptEngine: new PromptEngine({
        model: card.model,
        maxTokens: 4096,
        staticCtx: { tools: workerRegistry.getDefinitions() },
        volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock() },
      }),
      toolRegistry: workerRegistry,
      cwd,
      maxTurns: 4,
      contextWindow: card.contextWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    _coordinatorRef = new DelegationCoordinator({
      baseToolRegistry: toolRegistry,
      modelCards,
      maxWorkers: 2,
      runtimeFactory,
    })

    return new AgentLoop(
      {
        client,
        promptEngine,
        toolRegistry,
        maxTurns: config.agent.maxTurns,
        contextWindow: currentModel.contextWindow,
        compact: config.compact,
        compactClient,
        compactModel: compactModel?.id,
        approvalMode: config.agent.approval as 'auto-accept' | 'auto-safe' | 'manual',
        sessionId,
        getSessionMemoryState: () => persist.getSessionMemoryState(),
      },
      session,
      cwd,
    )
  }, [currentModel, toolVersion])

  const availableModels = provider.models.map(m => ({ id: m.id, alias: m.alias ?? m.id }))

  const handleModelSwitch = useCallback((modelId: string) => {
    const found = provider.models.find(m => m.id === modelId || m.alias === modelId)
    if (found) setCurrentModel(found)
  }, [provider.models])

  // Register shutdown callback for signal handlers
  useEffect(() => {
    shutdownCallback = () => {
      agent.abort()
      killAll()
      _mcpManager?.shutdown().catch(() => {})
      persist.compact(session.getMessages())
    }
    return () => { shutdownCallback = null }
  }, [agent, persist, session])

  return createElement(App, {
    agent,
    session,
    persist,
    model: currentModel.alias ?? currentModel.id,
    maxTokens: currentModel.contextWindow,
    currentSessionId: sessionId,
    availableModels,
    onModelSwitch: handleModelSwitch,
    initialInput,
    mcpManagerRef,
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

  if (args[0] === 'config') {
    runConfigCLI(args.slice(1))
    return
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
