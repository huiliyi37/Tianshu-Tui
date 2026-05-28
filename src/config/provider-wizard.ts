import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { ModelConfig } from './schema.js'
import { loadConfig, setupProvider } from './manager.js'
import { isProviderPresetKey, providerPresetKeys } from './provider-presets.js'

export interface ProviderWizardIO {
  ask?: (question: string) => Promise<string>
  write?: (line: string) => void
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

async function ask(io: Required<Pick<ProviderWizardIO, 'ask'>>, question: string): Promise<string> {
  return (await io.ask(question)).trim()
}

export async function runProviderConfigWizard(io: ProviderWizardIO = {}): Promise<void> {
  let close: (() => void) | undefined
  let askFn = io.ask
  if (!askFn) {
    const rl = createInterface({ input, output })
    askFn = question => rl.question(question)
    close = () => rl.close()
  }

  const write = io.write ?? (line => output.write(`${line}\n`))
  const askIo = { ask: askFn }

  try {
    const config = loadConfig()
    write('Rivet provider configuration')
    write(`Built-in providers: ${providerPresetKeys.join(', ')}`)
    write(`Current default: ${config.provider.default}`)

    const providerAnswer = await ask(askIo, 'Provider [deepseek|glm|mimo|minimax|codex]: ')
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
      const authMode = await ask(askIo, 'Auth mode [env|inline|keep]: ')
      if (authMode === 'env') {
        apiKeyEnv = await ask(askIo, 'API key env var: ')
      } else if (authMode === 'inline') {
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
      const contextWindow = positiveIntOrDefault(
        await ask(askIo, `Context window [${currentModel?.contextWindow ?? 128000}]: `),
        currentModel?.contextWindow ?? 128000,
        'context window',
      )
      const maxTokens = positiveIntOrDefault(
        await ask(askIo, `Max tokens [${currentModel?.maxTokens ?? 64000}]: `),
        currentModel?.maxTokens ?? 64000,
        'max tokens',
      )
      model = {
        id: modelId,
        ...(aliasAnswer ? { alias: aliasAnswer } : {}),
        contextWindow,
        maxTokens,
        reasoningEffort: currentModel?.reasoningEffort,
      }
    }

    const makeDefault = yes(await ask(askIo, 'Set as default? [y/N]: '))

    setupProvider({
      providerName,
      preset,
      apiKey,
      apiKeyEnv,
      baseUrl,
      model,
      makeDefault,
    })
    write(`Provider ${providerName} configured. Run "rivet config providers" to inspect.`)
  } finally {
    close?.()
  }
}
