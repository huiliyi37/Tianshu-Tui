import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { ModelConfig } from './schema.js'
import { loadConfig, registerProvider, setupProvider } from './manager.js'
import { userConfigPath } from './paths.js'
import { findPresetModel, isProviderPresetKey, providerPresetKeys } from './provider-presets.js'
import { probeProvider, type ProbeOptions, type ProbeReport } from '../api/provider-probe.js'
import { matchModelIds } from '../api/model-id-matcher.js'
import { toModelDescriptors } from './provider-cli.js'
import { suggestProviderName } from '../tui/connect-flow.js'

export interface ProviderWizardIO {
  ask?: (question: string) => Promise<string>
  write?: (line: string) => void
  /** Injectable probe (tests stub this; production hits the real endpoint). */
  probe?: (options: ProbeOptions) => Promise<ProbeReport>
}

function yes(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

function positiveIntOrDefault(value: string, fallback: number, label: string): number {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

/** Parse "1,3-5" style selection into 0-based indices; empty → all. */
export function parseModelSelection(answer: string, count: number): number[] {
  const trimmed = answer.trim()
  if (!trimmed) return Array.from({ length: count }, (_, i) => i)
  const picked = new Set<number>()
  for (const part of trimmed.split(/[,，\s]+/)) {
    if (!part) continue
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const from = Number.parseInt(range[1]!, 10)
      const to = Number.parseInt(range[2]!, 10)
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        if (i >= 1 && i <= count) picked.add(i - 1)
      }
      continue
    }
    const single = Number.parseInt(part, 10)
    if (Number.isInteger(single) && single >= 1 && single <= count) picked.add(single - 1)
  }
  return [...picked].sort((a, b) => a - b)
}

async function ask(io: Required<Pick<ProviderWizardIO, 'ask'>>, question: string): Promise<string> {
  return (await io.ask(question)).trim()
}

/** Probe-first custom provider onboarding — same core as `rivet provider add`. */
async function runCustomProviderWizard(
  io: Required<Pick<ProviderWizardIO, 'ask'>> & ProviderWizardIO,
  write: (line: string) => void,
): Promise<void> {
  const askIo = { ask: io.ask! }
  const probe = io.probe ?? probeProvider

  const baseUrl = await ask(askIo, 'Base URL (e.g. https://api.example.com/v1): ')
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) throw new Error(`Invalid base URL: "${baseUrl}"`)
  const apiKeyRaw = await ask(askIo, 'API key (Enter to skip — local endpoints need none): ')
  const apiKey = apiKeyRaw || undefined

  write(`Probing ${baseUrl} ...`)
  let report: ProbeReport
  try {
    report = await probe({ baseUrl, apiKey })
  } catch (e) {
    throw new Error(`Probe failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  write(`  Models list: ${report.modelsOk ? `${report.models.length} model(s)` : 'unavailable'}`)
  write(`  Completion probe: ${report.completionOk ? 'ok' : 'failed/skipped'}`)
  if (report.hints.reasoningSplit) write('  Hint: endpoint emits reasoning_content → capabilities.reasoningSplit: true')
  for (const error of report.errors) write(`  ⚠ ${error}`)

  let models: Array<Partial<ModelConfig> & { id: string }> = []
  if (report.models.length > 0) {
    const matches = matchModelIds(report.models)
    const { models: descriptors, notes } = toModelDescriptors(matches)
    matches.forEach((match, i) => {
      const tag = match.entry ? (match.tier === 'fuzzy' ? ` ≈ ${match.entry.canonicalId} (低置信)` : ` ≈ ${match.entry.canonicalId}`) : ' [TODO: 未知模型]'
      write(`  ${i + 1}. ${match.rawId}${tag}`)
    })
    for (const note of notes) write(`  ${note}`)
    const selection = parseModelSelection(await ask(askIo, `Select models [1-${report.models.length}] (Enter = all, e.g. "1,3-5"): `), report.models.length)
    if (selection.length === 0) throw new Error('No models selected — aborting (re-run and pick at least one).')
    models = selection.map(i => descriptors[i]!)
  } else {
    const modelId = await ask(askIo, 'Model ID (endpoint returned no model list): ')
    if (!modelId) throw new Error('No model ID provided — aborting.')
    models = [{ id: modelId }]
  }

  const defaultName = suggestProviderName(baseUrl)
  const nameAnswer = await ask(askIo, `Provider name [${defaultName}]: `)
  const providerName = (nameAnswer || defaultName).toLowerCase()
  if (isProviderPresetKey(providerName)) {
    throw new Error(`"${providerName}" is a built-in preset name — pick a different name for a custom provider.`)
  }
  const makeDefault = yes(await ask(askIo, 'Set as default? [Y/n]: ') || 'y')

  registerProvider({
    providerName,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    models,
    makeDefault,
  })
  write(`Provider "${providerName}" registered with ${models.length} model(s).`)
}

/**
 * 首次配置向导。返回 `{ skipped: true }` 表示用户选择跳过（进 TUI 后再配），
 * 此时不应重试 bootstrap——调用方应让会话以降级模式启动（发消息时报错指引配 key）。
 */
export async function runProviderConfigWizard(io: ProviderWizardIO = {}): Promise<{ skipped?: boolean }> {
  let close: (() => void) | undefined
  let askFn = io.ask
  if (!askFn) {
    const rl = createInterface({ input, output })
    askFn = question => rl.question(question)
    close = () => rl.close()
  }

  const write = io.write ?? (line => output.write(`${line}\n`))
  const wizardIo: ProviderWizardIO & Required<Pick<ProviderWizardIO, 'ask'>> = { ...io, ask: askFn }
  const askIo = { ask: askFn }

  try {
    const config = loadConfig()
    write('Rivet provider configuration')
    write(`Built-in providers: ${providerPresetKeys.join(', ')}`)
    write(`Current default: ${config.provider.default}`)

    // 跳过选项——新用户可以先看界面，稍后用 /config 或 rivet config setup 配 key。
    // 直接回车 = 跳过（降低首启摩擦，与桌面端「先进界面再提醒」体验对齐）。
    const skipAnswer = await ask(askIo, 'Configure now? [Y/n] (Enter=n=skip, configure later via /config): ')
    if (!yes(skipAnswer)) {
      write('')
      write('Skipped. You can configure later with:')
      write('  rivet provider add <name> --base-url <url>   (probe-first, any OpenAI-compatible endpoint)')
      write('  rivet config setup deepseek --key YOUR_KEY --default')
      write('  (or run `rivet config` for the interactive wizard)')
      write('  (or set DEEPSEEK_API_KEY environment variable)')
      write('Messages will fail until a key is configured.')
      return { skipped: true }
    }

    const providerAnswer = await ask(askIo, `Provider [${providerPresetKeys.join('|')}|custom]: `)
    if ((providerAnswer || '').toLowerCase() === 'custom') {
      await runCustomProviderWizard(wizardIo, write)
      write('Run "rivet provider list" to inspect.')
      return {}
    }
    const providerName = providerAnswer || config.provider.default
    const current = config.provider.providers[providerName]
    const preset = isProviderPresetKey(providerName) ? providerName : undefined
    if (!current && !preset) {
      throw new Error(`Provider "${providerName}" is not configured and has no built-in preset`)
    }

    const baseProvider = current ?? (preset ? loadConfig().provider.providers[preset] : undefined)
    const currentModel = baseProvider?.models[0]

    let apiKey: string | undefined
    let apiKeyEnv: string | undefined
    const isOAuth = providerName === 'codex' || current?.auth?.type === 'oauth'
    if (!isOAuth) {
      write('How to store the API key:')
      write(`  inline - write it to ${userConfigPath()} (recommended for personal use)`)
      write('  env    - read it from a shell environment variable (for shared/CI setups)')
      write('  keep   - leave the existing key setting unchanged')
      write('（个人使用直接回车选 inline，key 会写入上面的配置文件；env/keep 给进阶场景用）')
      const authMode = await ask(askIo, 'Auth mode [inline|env|keep]: ')
      if (authMode === 'env') {
        apiKeyEnv = await ask(askIo, 'API key env var: ')
      } else if (authMode === 'inline' || authMode === '') {
        apiKey = await ask(askIo, 'API key: ')
      } else if (authMode && authMode !== 'keep') {
        throw new Error(`Unknown auth mode: ${authMode}`)
      }
    }

    const defaultUrl = current?.baseUrl ?? baseProvider?.baseUrl ?? ''
    const urlAnswer = await ask(askIo, `Base URL [${defaultUrl}]: `)
    const baseUrl = urlAnswer || undefined

    const modelId = await ask(askIo, `Model ID [${currentModel?.id ?? ''}]: `)
    let model: ModelConfig | undefined
    if (modelId) {
      const aliasAnswer = await ask(askIo, 'Model alias: ')
      // Preset-aware defaults: a known model (e.g. deepseek-v4-pro) defaults
      // to its real context window instead of a blanket 128K — compaction
      // thresholds scale with this value, so a wrong small window silently
      // triggers premature compaction on 1M models.
      const presetModel = findPresetModel(providerName, modelId)
      const defaultContextWindow = presetModel?.contextWindow ?? currentModel?.contextWindow ?? 128000
      const defaultMaxTokens = presetModel?.maxTokens ?? currentModel?.maxTokens ?? 64000
      const contextWindow = positiveIntOrDefault(
        await ask(askIo, `Context window [${defaultContextWindow}]: `),
        defaultContextWindow,
        'context window',
      )
      const maxTokens = positiveIntOrDefault(
        await ask(askIo, `Max tokens [${defaultMaxTokens}]: `),
        defaultMaxTokens,
        'max tokens',
      )
      model = {
        id: modelId,
        ...(aliasAnswer ? { alias: aliasAnswer } : {}),
        contextWindow,
        maxTokens,
        reasoningEffort: presetModel?.reasoningEffort ?? currentModel?.reasoningEffort,
      }
    }

    const makeDefault = yes(await ask(askIo, 'Set as default? [y/N]: '))
    const allowProFallback = yes(await ask(askIo, 'Allow strong/pro models as fallback? [y/N]: '))

    setupProvider({
      providerName,
      preset,
      apiKey,
      apiKeyEnv,
      baseUrl,
      model,
      makeDefault,
      allowProFallback,
    })
    write(`Provider ${providerName} configured. Run "rivet config providers" to inspect.`)
    return {}
  } finally {
    close?.()
  }
}
