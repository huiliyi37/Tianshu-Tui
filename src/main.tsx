import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { render } from 'ink'
import { createElement } from 'react'
import { App } from './tui/app.js'
import { AgentLoop } from './agent/loop.js'
import { SessionContext } from './agent/context.js'
import { PromptEngine } from './prompt/engine.js'
import { ToolRegistry } from './tools/registry.js'
import { READ_FILE_TOOL } from './tools/read-file.js'
import { WRITE_FILE_TOOL } from './tools/write-file.js'
import { BASH_TOOL } from './tools/bash.js'
import { EDIT_FILE_TOOL } from './tools/edit.js'
import { createDeepSeekClient } from './api/deepseek.js'
import { configSchema } from './config/schema.js'
import { DEFAULT_CONFIG } from './config/default.js'
import type { Config } from './config/schema.js'

function loadConfig(): Config {
  const configPath = join(homedir(), '.opencode', 'config.json')

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      const merged = { ...DEFAULT_CONFIG, ...raw }
      return configSchema.parse(merged)
    } catch (err) {
      console.error('Config file error, using defaults:', (err as Error).message)
    }
  }

  return configSchema.parse(DEFAULT_CONFIG)
}

async function main() {
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

  const model = provider.models[0]!
  const cwd = process.cwd()

  // Tools
  const toolRegistry = new ToolRegistry()
  toolRegistry.register(READ_FILE_TOOL)
  toolRegistry.register(WRITE_FILE_TOOL)
  toolRegistry.register(BASH_TOOL)
  toolRegistry.register(EDIT_FILE_TOOL)

  // Prompt engine (system prompt frozen here → cache anchor)
  const promptEngine = new PromptEngine({
    model: model.id,
    maxTokens: model.maxTokens,
    staticCtx: { cwd, tools: toolRegistry.getDefinitions() },
    volatileCtx: { cwd },
  })

  // API client
  const client = createDeepSeekClient({
    apiKey,
    model: model.id,
    reasoningEffort: model.reasoningEffort,
    maxTokens: model.maxTokens,
  })

  // Agent + session
  const session = new SessionContext()
  const agent = new AgentLoop(
    {
      client,
      promptEngine,
      toolRegistry,
      maxTurns: config.agent.maxTurns,
      contextWindow: model.contextWindow,
      compact: config.compact,
    },
    session,
    cwd,
  )

  // Render TUI
  const { waitUntilExit } = render(
    createElement(App, {
      agent,
      session,
      model: model.alias ?? model.id,
      maxTokens: model.contextWindow,
    }),
  )

  await waitUntilExit()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
