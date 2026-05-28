import { readFileSync, existsSync } from 'fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { configSchema, type Config, type ProviderConfig, type ModelConfig } from './schema.js'
import { DEFAULT_CONFIG } from './default.js'
import { cloneProviderPreset, isProviderPresetKey, type ProviderPresetKey } from './provider-presets.js'

const DEFAULT_CONFIG_PATH = join(homedir(), '.rivet', 'config.json')

export function getUserConfigPath(): string {
  return process.env.RIVET_CONFIG_PATH ?? DEFAULT_CONFIG_PATH
}

/** Project-level config file name (checked in cwd and parent dirs) */
const PROJECT_CONFIG_FILE = '.rivet-config.json'

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    if (sv === null) {
      delete result[key]
    } else if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>)
    } else {
      result[key] = sv
    }
  }
  return result
}

/**
 * Walk up from startDir to find the nearest .rivet-config.json.
 * Returns the absolute path or undefined if not found.
 */
export function findProjectConfig(startDir: string): string | undefined {
  let dir = resolve(startDir)
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, PROJECT_CONFIG_FILE)
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break // reached root
    dir = parent
  }
  return undefined
}

/**
 * Load config with 3-layer resolution: user → project → session overlay.
 *
 * Priority (highest wins):
 * 1. sessionOverlay — runtime-only, per-session overrides (never persisted here)
 * 2. projectConfig — .rivet-config.json found by walking up from cwd
 * 3. userConfig — ~/.rivet/config.json (global)
 * 4. DEFAULT_CONFIG — built-in defaults
 *
 * Each layer is deep-merged onto the previous, then the result is
 * validated through the Zod configSchema.
 */
export function loadConfig(options?: {
  cwd?: string
  projectConfigPath?: string
  sessionOverlay?: Record<string, unknown>
}): Config {
  // Layer 1: defaults
  let base = DEFAULT_CONFIG as unknown as Record<string, unknown>

  // Layer 2: user global config
  const configPath = getUserConfigPath()
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      base = deepMerge(base, raw as Record<string, unknown>)
    } catch {
      // malformed user config — fall through to defaults
    }
  }

  // Layer 3: project config
  const projectPath = options?.projectConfigPath
    ?? (options?.cwd ? findProjectConfig(options.cwd) : undefined)
  if (projectPath && existsSync(projectPath)) {
    try {
      const raw = JSON.parse(readFileSync(projectPath, 'utf-8'))
      base = deepMerge(base, raw as Record<string, unknown>)
    } catch {
      // malformed project config — skip
    }
  }

  // Layer 4: session overlay (runtime-only, e.g. from CLI flags)
  if (options?.sessionOverlay) {
    base = deepMerge(base, options.sessionOverlay)
  }

  return configSchema.parse(base)
}

/** Load config with backward-compatible signature (no options). */
export function loadConfigDefault(): Config {
  return loadConfig()
}

function saveConfig(config: Config): void {
  writeFileAtomicSync(getUserConfigPath(), JSON.stringify(config, null, 2) + '\n')
}

// --- Provider management ---

export function listProviders(): string[] {
  return Object.keys(loadConfig().provider.providers)
}

export function getProvider(name: string): ProviderConfig | undefined {
  return loadConfig().provider.providers[name]
}

export function getDefaultProvider(): string {
  return loadConfig().provider.default
}

export function addProvider(name: string, config: ProviderConfig): void {
  const cfg = loadConfig()
  cfg.provider.providers[name] = config
  saveConfig(cfg)
}

export function removeProvider(name: string): void {
  const cfg = loadConfig()
  if (cfg.provider.default === name) {
    throw new Error(`Cannot remove default provider "${name}". Set a different default first.`)
  }
  delete cfg.provider.providers[name]
  saveConfig(cfg)
}

export function setDefaultProvider(name: string): void {
  const cfg = loadConfig()
  if (!cfg.provider.providers[name]) {
    throw new Error(`Provider "${name}" not found. Available: ${Object.keys(cfg.provider.providers).join(', ')}`)
  }
  cfg.provider.default = name
  saveConfig(cfg)
}

// --- API key management ---

export function setApiKey(providerName: string, key: string): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.apiKey = key
  ;(provider as unknown as { apiKeyEnv?: string | null }).apiKeyEnv = null
  saveConfig(cfg)
}

export function setApiKeyEnv(providerName: string, envVar: string): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.apiKeyEnv = envVar
  ;(provider as unknown as { apiKey?: string | null }).apiKey = null
  saveConfig(cfg)
}

export function getApiKeyStatus(providerName: string): { source: 'inline' | 'env' | 'none'; ref: string } {
  const provider = getProvider(providerName)
  if (!provider) return { source: 'none', ref: '' }
  if (provider.apiKey) return { source: 'inline', ref: '***' + provider.apiKey.slice(-4) }
  if (provider.apiKeyEnv) return { source: 'env', ref: provider.apiKeyEnv }
  return { source: 'none', ref: '' }
}

export interface UpsertProviderModelOptions {
  preferred?: boolean
}

export interface SetupProviderOptions {
  providerName: string
  preset?: ProviderPresetKey
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
  model?: ModelConfig
  makeDefault?: boolean
}

function assertValidUrl(value: string): void {
  try {
    new URL(value)
  } catch {
    throw new Error(`Invalid provider baseUrl: ${value}`)
  }
}

export function updateProviderBaseUrl(providerName: string, baseUrl: string): void {
  assertValidUrl(baseUrl)
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.baseUrl = baseUrl
  saveConfig(cfg)
}

export function upsertProviderModel(providerName: string, model: ModelConfig, options: UpsertProviderModelOptions = {}): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  const existingIndex = provider.models.findIndex(item => item.id === model.id || (model.alias !== undefined && item.alias === model.alias))
  if (existingIndex >= 0) provider.models[existingIndex] = model
  else provider.models.push(model)
  if (options.preferred) {
    const preferredIndex = provider.models.findIndex(item => item.id === model.id)
    const preferred = provider.models.splice(preferredIndex, 1)[0]
    if (preferred) provider.models.unshift(preferred)
  }
  saveConfig(cfg)
}

export function setupProvider(options: SetupProviderOptions): void {
  const cfg = loadConfig()
  const presetKey = options.preset ?? (isProviderPresetKey(options.providerName) ? options.providerName : undefined)
  const current = cfg.provider.providers[options.providerName]
  const base = presetKey ? cloneProviderPreset(presetKey) : current
  if (!base) throw new Error(`Provider "${options.providerName}" not found and no preset is available`)
  const next: ProviderConfig = structuredClone(base)
  next.name = options.providerName
  if (current) Object.assign(next, current)
  if (options.baseUrl) {
    assertValidUrl(options.baseUrl)
    next.baseUrl = options.baseUrl
  }
  if (options.apiKey) {
    next.apiKey = options.apiKey
    ;(next as unknown as { apiKeyEnv?: string | null }).apiKeyEnv = null
  }
  if (options.apiKeyEnv) {
    next.apiKeyEnv = options.apiKeyEnv
    ;(next as unknown as { apiKey?: string | null }).apiKey = null
  }
  if (options.model) {
    const existingIndex = next.models.findIndex(item => item.id === options.model!.id || (options.model!.alias !== undefined && item.alias === options.model!.alias))
    if (existingIndex >= 0) next.models[existingIndex] = options.model
    else next.models.unshift(options.model)
  }
  cfg.provider.providers[options.providerName] = next
  if (options.makeDefault) cfg.provider.default = options.providerName
  saveConfig(cfg)
}

// --- Model management ---

export function addModel(providerName: string, model: ModelConfig): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.models.push(model)
  saveConfig(cfg)
}

export function removeModel(providerName: string, modelId: string): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  if (provider.models.length <= 1) throw new Error('Provider must have at least one model')
  provider.models = provider.models.filter(m => m.id !== modelId)
  saveConfig(cfg)
}

export function listModels(providerName: string): ModelConfig[] {
  const provider = getProvider(providerName)
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  return provider.models
}

// --- CLI entry point ---

export function runConfigCLI(args: string[]): void {
  const cmd = args[0]
  try {
    switch (cmd) {
      case 'show':
        console.log(JSON.stringify(loadConfig(), null, 2))
        break

      case 'providers':
        console.log('Providers:')
        for (const [name, p] of Object.entries(loadConfig().provider.providers)) {
          const marker = name === loadConfig().provider.default ? ' (default)' : ''
          const keyStatus = getApiKeyStatus(name)
          console.log(`  ${name}${marker}`)
          console.log(`    baseUrl: ${p.baseUrl}`)
          console.log(`    apiKey: ${keyStatus.source === 'inline' ? keyStatus.ref : keyStatus.source === 'env' ? `$${keyStatus.ref}` : '(not set)'}`)
          console.log(`    models: ${p.models.map(m => m.alias ?? m.id).join(', ')}`)
        }
        break

      case 'set-key': {
        const providerName = args[1]
        const key = args[2]
        if (!providerName || !key) {
          console.error('Usage: rivet config set-key <provider> <api-key>')
          process.exit(1)
        }
        setApiKey(providerName, key)
        console.log(`API key set for ${providerName}`)
        break
      }

      case 'set-key-env': {
        const providerName = args[1]
        const envVar = args[2]
        if (!providerName || !envVar) {
          console.error('Usage: rivet config set-key-env <provider> <ENV_VAR>')
          process.exit(1)
        }
        setApiKeyEnv(providerName, envVar)
        console.log(`API key source set to $${envVar} for ${providerName}`)
        break
      }

      case 'set-default': {
        const providerName = args[1]
        if (!providerName) {
          console.error('Usage: rivet config set-default <provider>')
          process.exit(1)
        }
        setDefaultProvider(providerName)
        console.log(`Default provider set to ${providerName}`)
        break
      }

      case 'add-model': {
        const providerName = args[1]
        const modelId = args[2]
        const contextWindow = parseInt(args[3] ?? '1000000')
        const maxTokens = parseInt(args[4] ?? '64000')
        if (!providerName || !modelId) {
          console.error('Usage: rivet config add-model <provider> <model-id> [context-window] [max-tokens]')
          process.exit(1)
        }
        addModel(providerName, { id: modelId, contextWindow, maxTokens })
        console.log(`Model ${modelId} added to ${providerName}`)
        break
      }

      case 'remove-model': {
        const providerName = args[1]
        const modelId = args[2]
        if (!providerName || !modelId) {
          console.error('Usage: rivet config remove-model <provider> <model-id>')
          process.exit(1)
        }
        removeModel(providerName, modelId)
        console.log(`Model ${modelId} removed from ${providerName}`)
        break
      }

      case 'mcp': {
        const subcmd = args[1]
        if (subcmd === 'list') {
          const cfg = loadConfig()
          const servers = cfg.mcp?.servers ?? {}
          const entries = Object.entries(servers)
          if (entries.length === 0) {
            console.log('No MCP servers configured.')
          } else {
            console.log('MCP servers:')
            for (const [id, s] of entries) {
              const type = s.command ? `stdio: ${s.command}` : `sse: ${s.url}`
              const disabled = s.disabled ? ' (disabled)' : ''
              console.log(`  ${id}: ${type}${disabled}`)
            }
          }
        } else if (subcmd === 'add-stdio') {
          const id = args[2]
          const command = args[3]
          const cmdArgs = args.slice(4)
          if (!id || !command) {
            console.error('Usage: rivet config mcp add-stdio <id> <command> [args...]')
            process.exit(1)
          }
          const cfg = loadConfig()
          cfg.mcp.servers[id] = { command, args: cmdArgs.length > 0 ? cmdArgs : undefined }
          saveConfig(cfg)
          console.log(`MCP server "${id}" added (stdio: ${command} ${cmdArgs.join(' ')}). Restart Rivet to connect.`)
        } else if (subcmd === 'add-sse') {
          const id = args[2]
          const url = args[3]
          if (!id || !url) {
            console.error('Usage: rivet config mcp add-sse <id> <url>')
            process.exit(1)
          }
          const cfg = loadConfig()
          cfg.mcp.servers[id] = { url }
          saveConfig(cfg)
          console.log(`MCP server "${id}" added (sse: ${url}). Restart Rivet to connect.`)
        } else if (subcmd === 'remove') {
          const id = args[2]
          if (!id) {
            console.error('Usage: rivet config mcp remove <id>')
            process.exit(1)
          }
          const cfg = loadConfig()
          if (!cfg.mcp?.servers[id]) {
            console.error(`MCP server "${id}" not found.`)
            process.exit(1)
          }
          delete cfg.mcp.servers[id]
          saveConfig(cfg)
          console.log(`MCP server "${id}" removed. Restart Rivet to apply.`)
        } else if (subcmd === 'enable' || subcmd === 'disable') {
          const id = args[2]
          if (!id) {
            console.error(`Usage: rivet config mcp ${subcmd} <id>`)
            process.exit(1)
          }
          const cfg = loadConfig()
          const server = cfg.mcp?.servers[id]
          if (!server) {
            console.error(`MCP server "${id}" not found.`)
            process.exit(1)
          }
          server.disabled = subcmd === 'disable' ? true : undefined
          saveConfig(cfg)
          console.log(`MCP server "${id}" ${subcmd}d. Restart Rivet to apply.`)
        } else {
          console.log(`MCP server management:

Usage: rivet config mcp <command>

Commands:
  list                        List configured MCP servers
  add-stdio <id> <cmd> [args...]  Add a stdio MCP server
  add-sse <id> <url>          Add an SSE MCP server
  remove <id>                 Remove an MCP server
  enable <id>                 Enable an MCP server
  disable <id>                Disable an MCP server (keeps config)

Examples:
  rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp
  rivet config mcp add-sse ctx7 http://localhost:3001/sse
  rivet config mcp list
  rivet config mcp remove fs`)
        }
        break
      }

      default:
        console.log(`Rivet Config Manager

Usage: rivet config <command>

Commands:
  show                Show full config (JSON)
  providers           List providers with key status
  set-key <p> <key>   Set API key for provider
  set-key-env <p> <v> Set API key from env variable
  set-default <p>     Set default provider
  add-model <p> <id>  Add model to provider
  remove-model <p> <id> Remove model from provider
  mcp                 MCP server management

Examples:
  rivet config providers
  rivet config set-key deepseek sk-xxx
  rivet config set-key-env deepseek DEEPSEEK_API_KEY
  rivet config add-model deepseek deepseek-v4-flash 1000000 64000
  rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp`)
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
}
