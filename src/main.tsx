import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { render } from 'ink'
import { createElement, useState, useMemo, useCallback, useEffect } from 'react'
import { App } from './tui/app.js'
import { ErrorBoundary } from './tui/error-boundary.js'
import { AgentLoop } from './agent/loop.js'
import { SessionContext } from './agent/context.js'
import { SessionPersist } from './agent/session-persist.js'
import { PromptEngine } from './prompt/engine.js'
import { ToolRegistry } from './tools/registry.js'
import { READ_FILE_TOOL } from './tools/read-file.js'
import { WRITE_FILE_TOOL } from './tools/write-file.js'
import { BASH_TOOL } from './tools/bash.js'
import { EDIT_FILE_TOOL } from './tools/edit.js'
import { createDeepSeekClient } from './api/deepseek.js'
import { killAll } from './tools/process-tracker.js'
import { configSchema } from './config/schema.js'
import { DEFAULT_CONFIG } from './config/default.js'
import { runConfigCLI } from './config/manager.js'
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
  const idFile = join(dir, 'session-id.txt')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  if (existsSync(idFile)) {
    const id = readFileSync(idFile, 'utf-8').trim()
    if (id) return id
  }
  const id = randomUUID()
  writeFileSync(idFile, id)
  return id
}

// Module-level shutdown callback — set by Root component, called by signal handlers
let shutdownCallback: (() => void) | null = null

// Module-level initial input (from pipe stdin)
let _pipedInput: string | undefined

function gracefulShutdown() {
  shutdownCallback?.()
  process.exit(0)
}

function Root({ provider, apiKey, config }: { provider: ProviderConfig; apiKey: string; config: Config }) {
  const initialInput = _pipedInput
  const cwd = process.cwd()

  // Stable singletons — created once, never change
  const [toolRegistry] = useState(() => {
    const reg = new ToolRegistry()
    reg.register(READ_FILE_TOOL)
    reg.register(WRITE_FILE_TOOL)
    reg.register(BASH_TOOL)
    reg.register(EDIT_FILE_TOOL)
    return reg
  })

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
      staticCtx: { cwd, tools: toolRegistry.getDefinitions() },
      volatileCtx: { cwd },
    })
    const client = createDeepSeekClient({
      apiKey,
      model: currentModel.id,
      reasoningEffort: currentModel.reasoningEffort,
      maxTokens: currentModel.maxTokens,
      thinkingBudget: Math.min(16000, Math.floor(currentModel.contextWindow * 0.02)),
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
      },
      session,
      cwd,
    )
  }, [currentModel])

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
  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
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
  )

  process.on('SIGINT', gracefulShutdown)
  process.on('SIGTERM', gracefulShutdown)

  await waitUntilExit()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
