/**
 * `rivet provider <add|list|models|probe|remove>` — unified provider
 * onboarding CLI (Wave 3). Same write core (manager.registerProvider) and
 * same probe (api/provider-probe) as the desktop routes and the /connect
 * wizard; same-name writes require explicit --force.
 */
import { loadConfig, registerProvider, removeProvider, getApiKeyStatus } from './manager.js'
import { readSecret } from './secrets-store.js'
import { probeProvider, aliasTableWithProbeInfos, type ProbeReport } from '../api/provider-probe.js'
import { normalizeBaseUrl } from '../api/endpoint-map.js'
import { matchModelIds, type ModelMatchResult } from '../api/model-id-matcher.js'
import type { ModelAliasMetadata } from '../api/model-aliases.js'
import type { ModelConfig } from './schema.js'

export interface ProviderCliIO {
  write?: (line: string) => void
  writeErr?: (line: string) => void
  exit?: (code: number) => void
}

const out = (io: ProviderCliIO, line: string) => (io.write ?? console.log)(line)
const err = (io: ProviderCliIO, line: string) => (io.writeErr ?? console.error)(line)
const exit = (io: ProviderCliIO, code: number) => (io.exit ?? process.exit)(code)

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function printHelp(io: ProviderCliIO): void {
  out(io, `Rivet Provider Management

Usage: rivet provider <command>

Commands:
  add <name> --base-url <url>   Add a custom provider (probe-first)
      [--api-key KEY] [--api-key-env ENV] [--protocol openai|anthropic]
      [--no-probe] [--force] [--default]
  list                          List configured providers
  models <name>                 Fetch the endpoint's model list and print a
                                pasteable models[] snippet (alias-table matched)
  probe <name>                  Probe a configured provider (models + completion)
  remove <name>                 Remove a provider (its model group + stored API key)

Examples:
  rivet provider add my-relay --base-url http://127.0.0.1:3000/v1 --api-key-env RELAY_API_KEY
  rivet provider add claude-proxy --base-url https://proxy.example.com --protocol anthropic
  rivet provider models my-relay`)
}

/** Resolve a usable API key without throwing — local endpoints need none. */
function bestEffortApiKey(provider: { apiKey?: string; apiKeyEnv?: string; keyRef?: string; name: string }): string | undefined {
  if (provider.keyRef) {
    const secret = readSecret(provider.keyRef)
    if (secret) return secret
  }
  if (provider.apiKey) return provider.apiKey
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return process.env[provider.apiKeyEnv]
  const standard = process.env[`${provider.name.toUpperCase()}_API_KEY`]
  return standard
}

/**
 * Turn matcher results into config-ready model descriptors. Matched entries
 * backfill alias-table metadata (L1/L2 silently, L3 annotated); unknowns come
 * through as bare `{ id }` skeletons for the user to fill — never an error.
 * The endpoint's RAW id is kept as the config id: it must stay callable.
 */
export function toModelDescriptors(results: ModelMatchResult[]): {
  models: Array<Partial<ModelConfig> & { id: string }>
  notes: string[]
} {
  const models: Array<Partial<ModelConfig> & { id: string }> = []
  const notes: string[] = []
  for (const result of results) {
    if (!result.entry) {
      models.push({ id: result.rawId })
      notes.push(`[TODO] ${result.rawId}: 未匹配已知模型——请手填 contextWindow/maxTokens`)
      continue
    }
    const metadata: ModelAliasMetadata = result.entry.metadata
    const descriptor: Partial<ModelConfig> & { id: string } = {
      id: result.rawId,
      ...(metadata.contextWindow !== undefined ? { contextWindow: metadata.contextWindow } : {}),
      ...(metadata.maxTokens !== undefined ? { maxTokens: metadata.maxTokens } : {}),
      ...(metadata.reasoningEffort ? { reasoningEffort: metadata.reasoningEffort } : {}),
      ...(metadata.supportsVision !== undefined ? { supportsVision: metadata.supportsVision } : {}),
      ...(metadata.tier ? { tier: metadata.tier } : {}),
      ...(metadata.pricing ? { pricing: metadata.pricing } : {}),
      ...(metadata.capabilities && Object.keys(metadata.capabilities).length > 0 ? { capabilities: metadata.capabilities } : {}),
    }
    models.push(descriptor)
    if (result.tier === 'fuzzy') {
      notes.push(`[低置信] ${result.rawId} ≈ ${result.entry.canonicalId}（score ${result.confidence.toFixed(2)}）——元数据为推断值，请确认`)
    }
  }
  return { models, notes }
}

function formatProbeSummary(report: ProbeReport): string[] {
  const lines: string[] = []
  lines.push(`Models list: ${report.modelsOk ? `${report.models.length} model(s)` : 'unavailable'}`)
  lines.push(`Completion probe: ${report.completionOk ? `ok${report.latencyMs !== undefined ? ` (${report.latencyMs}ms)` : ''}` : 'failed/skipped'}`)
  if (report.hints.reasoningSplit) lines.push('Hint: endpoint emits reasoning_content → consider capabilities.reasoningSplit: true')
  for (const error of report.errors) lines.push(`⚠ ${error}`)
  return lines
}

async function cmdAdd(args: string[], io: ProviderCliIO): Promise<void> {
  const name = args[1]
  const rawBaseUrl = readFlag(args, '--base-url')
  if (!name || !rawBaseUrl) {
    err(io, 'Usage: rivet provider add <name> --base-url <url> [--api-key KEY|--api-key-env ENV] [--protocol anthropic] [--no-probe] [--force] [--default]')
    exit(io, 1)
    return
  }
  const baseUrl = normalizeBaseUrl(rawBaseUrl)
  if (baseUrl !== rawBaseUrl) out(io, `Base URL normalized: ${rawBaseUrl} → ${baseUrl}`)
  const apiKey = readFlag(args, '--api-key')
  const apiKeyEnv = readFlag(args, '--api-key-env')
  const protocolRaw = readFlag(args, '--protocol')
  if (protocolRaw !== undefined && protocolRaw !== 'openai' && protocolRaw !== 'anthropic') {
    err(io, `Invalid --protocol "${protocolRaw}" (expected openai or anthropic)`)
    exit(io, 1)
    return
  }
  const protocol = protocolRaw as 'openai' | 'anthropic' | undefined
  const noProbe = hasFlag(args, '--no-probe')
  const key = apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined)

  let models: Array<Partial<ModelConfig> & { id: string }> = []
  if (!noProbe) {
    out(io, `Probing ${baseUrl} ...`)
    const report = await probeProvider({ baseUrl, apiKey: key, protocol, providerName: name })
    for (const line of formatProbeSummary(report)) out(io, `  ${line}`)
    if (report.models.length > 0) {
      const { models: descriptors, notes } = toModelDescriptors(matchModelIds(report.models, aliasTableWithProbeInfos(report.modelInfos)))
      models = descriptors
      for (const note of notes) err(io, note)
    }
  }

  registerProvider({
    providerName: name,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(protocol ? { protocol } : {}),
    models,
    makeDefault: hasFlag(args, '--default'),
    force: hasFlag(args, '--force'),
  })
  out(io, `Provider "${name}" registered${models.length > 0 ? ` with ${models.length} model(s)` : ' (no models yet — run `rivet provider models ' + name + '`)'}.`)
}

async function cmdModels(args: string[], io: ProviderCliIO): Promise<void> {
  const name = args[1]
  if (!name) {
    err(io, 'Usage: rivet provider models <name>')
    exit(io, 1)
    return
  }
  const provider = loadConfig().provider.providers[name]
  if (!provider) {
    err(io, `Provider "${name}" not found. Run \`rivet provider list\` or \`rivet provider add ${name} --base-url <url>\`.`)
    exit(io, 1)
    return
  }
  const report = await probeProvider({
    baseUrl: provider.baseUrl,
    apiKey: bestEffortApiKey(provider),
    protocol: provider.protocol,
    providerName: name,
    skipCompletion: true,
  })
  if (!report.modelsOk) {
    for (const error of report.errors) err(io, `⚠ ${error}`)
    exit(io, 1)
    return
  }
  const { models, notes } = toModelDescriptors(matchModelIds(report.models, aliasTableWithProbeInfos(report.modelInfos)))
  for (const note of notes) err(io, note)
  out(io, JSON.stringify({ models }, null, 2))
}

async function cmdProbe(args: string[], io: ProviderCliIO): Promise<void> {
  const name = args[1]
  if (!name) {
    err(io, 'Usage: rivet provider probe <name>')
    exit(io, 1)
    return
  }
  const provider = loadConfig().provider.providers[name]
  if (!provider) {
    err(io, `Provider "${name}" not found. Run \`rivet provider list\`.`)
    exit(io, 1)
    return
  }
  const report = await probeProvider({
    baseUrl: provider.baseUrl,
    apiKey: bestEffortApiKey(provider),
    protocol: provider.protocol,
    providerName: name,
    probeModel: provider.models[0]?.id,
  })
  for (const line of formatProbeSummary(report)) out(io, line)
  if (report.models.length > 0) out(io, `Models: ${report.models.join(', ')}`)
  exit(io, report.completionOk ? 0 : 1)
}

function cmdList(io: ProviderCliIO): void {
  const cfg = loadConfig()
  const entries = Object.entries(cfg.provider.providers)
  if (entries.length === 0) {
    out(io, 'No providers configured. Run `rivet provider add <name> --base-url <url>`.')
    return
  }
  for (const [name, provider] of entries) {
    const key = getApiKeyStatus(name)
    const star = name === cfg.provider.default ? ' *' : ''
    out(io, `${name}${star}  [${provider.protocol}]  ${provider.baseUrl}  models=${provider.models.length}  key=${key.source === 'none' ? 'missing' : key.source}`)
  }
}

function cmdRemove(args: string[], io: ProviderCliIO): void {
  const name = args[1]
  if (!name) {
    err(io, 'Usage: rivet provider remove <name>')
    exit(io, 1)
    return
  }
  const result = removeProvider(name)
  const secretNote = !result.keyRef
    ? ''
    : result.secretDeleted
      ? ' API key deleted from secrets.json.'
      : result.keyRefSharedWith.length > 0
        ? ` Key ref "${result.keyRef}" still referenced by ${result.keyRefSharedWith.join(', ')} — secret kept.`
        : ' (no stored key found)'
  out(io, `Provider "${name}" removed (${result.modelCount} models).${secretNote}`)
}

export async function runProviderCLI(args: string[], io: ProviderCliIO = {}): Promise<void> {
  const cmd = args[0]
  try {
    switch (cmd) {
      case 'add':
        await cmdAdd(args, io)
        return
      case 'list':
        cmdList(io)
        return
      case 'models':
        await cmdModels(args, io)
        return
      case 'probe':
        await cmdProbe(args, io)
        return
      case 'remove':
        cmdRemove(args, io)
        return
      default:
        printHelp(io)
        if (cmd) exit(io, 1)
    }
  } catch (error) {
    err(io, error instanceof Error ? error.message : String(error))
    exit(io, 1)
  }
}
