import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { configSchema, type Config, type ProviderConfig, type ModelConfig } from './schema.js'
import { DEFAULT_CONFIG } from './default.js'

const CONFIG_DIR = join(homedir(), '.opencode')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
}

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

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return configSchema.parse(DEFAULT_CONFIG)
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    const merged = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, raw as Record<string, unknown>)
    return configSchema.parse(merged)
  } catch {
    return configSchema.parse(DEFAULT_CONFIG)
  }
}

function saveConfig(config: Config): void {
  ensureConfigDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
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
  provider.apiKeyEnv = undefined
  saveConfig(cfg)
}

export function setApiKeyEnv(providerName: string, envVar: string): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.apiKeyEnv = envVar
  provider.apiKey = undefined
  saveConfig(cfg)
}

export function getApiKeyStatus(providerName: string): { source: 'inline' | 'env' | 'none'; ref: string } {
  const provider = getProvider(providerName)
  if (!provider) return { source: 'none', ref: '' }
  if (provider.apiKey) return { source: 'inline', ref: '***' + provider.apiKey.slice(-4) }
  if (provider.apiKeyEnv) return { source: 'env', ref: provider.apiKeyEnv }
  return { source: 'none', ref: '' }
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
          console.error('Usage: opencode config set-key <provider> <api-key>')
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
          console.error('Usage: opencode config set-key-env <provider> <ENV_VAR>')
          process.exit(1)
        }
        setApiKeyEnv(providerName, envVar)
        console.log(`API key source set to $${envVar} for ${providerName}`)
        break
      }

      case 'set-default': {
        const providerName = args[1]
        if (!providerName) {
          console.error('Usage: opencode config set-default <provider>')
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
          console.error('Usage: opencode config add-model <provider> <model-id> [context-window] [max-tokens]')
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
          console.error('Usage: opencode config remove-model <provider> <model-id>')
          process.exit(1)
        }
        removeModel(providerName, modelId)
        console.log(`Model ${modelId} removed from ${providerName}`)
        break
      }

      default:
        console.log(`OpenCode Config Manager

Usage: opencode config <command>

Commands:
  show                Show full config (JSON)
  providers           List providers with key status
  set-key <p> <key>   Set API key for provider
  set-key-env <p> <v> Set API key from env variable
  set-default <p>     Set default provider
  add-model <p> <id>  Add model to provider
  remove-model <p> <id> Remove model from provider

Examples:
  opencode config providers
  opencode config set-key deepseek sk-xxx
  opencode config set-key-env deepseek DEEPSEEK_API_KEY
  opencode config add-model deepseek deepseek-v4-flash 1000000 64000`)
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
}
