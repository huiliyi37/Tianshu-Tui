import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { loadConfig, setupProvider } from './manager.js'
import { userConfigPath } from './paths.js'
import { isProviderPresetKey, providerPresetKeys } from './provider-presets.js'

/**
 * 降级版 readline 首启向导：只做内置 preset 的最小接入（选 provider → key → 设默认）。
 * TUI 内首启走 /connect overlay；自定义端点走 `rivet provider add`（probe-first）。
 */
export interface ProviderWizardIO {
  ask?: (question: string) => Promise<string>
  /** Masked input for secrets. Falls back to `ask` when absent (tests script it). */
  askSecret?: (question: string) => Promise<string>
  write?: (line: string) => void
}

function yes(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

async function ask(io: Required<Pick<ProviderWizardIO, 'ask'>>, question: string): Promise<string> {
  return (await io.ask(question)).trim()
}

/**
 * Masked terminal input: keypresses are swallowed so the secret never
 * renders, even when pasted. Non-TTY stdin (pipes/CI) can't suppress echo —
 * warn and recommend env-var storage instead.
 */
async function askSecretTty(rl: ReadlineInterface, question: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    output.write(`${question}(non-interactive stdin — input is NOT masked; prefer env-var storage)\n`)
    return (await rl.question(question)).trim()
  }

  output.write(question)
  const sigintListeners = rl.listeners('SIGINT') as Array<(...args: unknown[]) => void>
  sigintListeners.forEach(l => rl.removeListener('SIGINT', l))
  input.setRawMode(true)
  input.resume()

  let secret = ''

  return await new Promise<string>((resolve, reject) => {
    const onKeypress = (_chunk: unknown, key?: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (!key) return
      if (key.name === 'return' || key.name === 'enter') {
        output.write('\n')
        cleanup()
        resolve(secret.trim())
      } else if (key.ctrl && key.name === 'c') {
        output.write('\n')
        cleanup()
        reject(new Error('Interrupted during API key input'))
      } else if (key.name === 'backspace') {
        secret = secret.slice(0, -1)
      } else if (key.ctrl && key.name === 'u') {
        secret = ''
      } else if (!key.ctrl && !key.meta) {
        const text = typeof _chunk === 'string' ? _chunk : Buffer.isBuffer(_chunk) ? _chunk.toString('utf8') : ''
        secret += text.replace(/[\r\n]/g, '')
      }
    }
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      input.setRawMode!(false)
      input.removeListener('keypress', onKeypress)
      sigintListeners.forEach(l => rl.on('SIGINT', l))
    }
    input.on('keypress', onKeypress)
  })
}

/**
 * 首次配置向导。返回 `{ skipped: true }` 表示用户选择跳过（进 TUI 后再配），
 * 此时不应重试 bootstrap——调用方应让会话以降级模式启动（发消息时报错指引配 key）。
 */
export async function runProviderConfigWizard(io: ProviderWizardIO = {}): Promise<{ skipped?: boolean }> {
  let rl: ReadlineInterface | undefined
  let askFn: (question: string) => Promise<string>
  let askSecretFn: (question: string) => Promise<string>
  if (io.ask) {
    askFn = io.ask
    askSecretFn = io.askSecret ?? io.ask
  } else {
    rl = createInterface({ input, output })
    askFn = question => rl!.question(question)
    askSecretFn = question => askSecretTty(rl!, question)
  }

  const write = io.write ?? (line => output.write(`${line}\n`))
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

    const providerAnswer = await ask(askIo, `Provider [${providerPresetKeys.join('|')}]: `)
    const providerName = (providerAnswer || config.provider.default).toLowerCase()
    if (providerName === 'custom') {
      write('Custom endpoints are handled by the probe-first CLI:')
      write('  rivet provider add <name> --base-url <url> [--api-key *** | --api-key-env VAR] [--default]')
      throw new Error('Custom provider setup aborted — use `rivet provider add` (see above).')
    }
    if (!isProviderPresetKey(providerName) && !config.provider.providers[providerName]) {
      throw new Error(`Provider "${providerName}" has no built-in preset and is not configured`)
    }

    let apiKey: string | undefined
    let apiKeyEnv: string | undefined
    const isOAuth = providerName === 'codex' || config.provider.providers[providerName]?.auth?.type === 'oauth'
    if (!isOAuth) {
      write('How to store the API key:')
      write(`  inline - write it to ${userConfigPath()} (recommended for personal use)`)
      write('  env    - read it from a shell environment variable (for shared/CI setups)')
      write('  keep   - leave the existing key setting unchanged')
      const authMode = await ask(askIo, 'Auth mode [inline|env|keep]: ')
      if (authMode === 'env') {
        apiKeyEnv = await ask(askIo, 'API key env var: ')
      } else if (authMode === 'inline' || authMode === '') {
        apiKey = await askSecretFn('API key (input hidden): ')
      } else if (authMode !== 'keep') {
        throw new Error(`Unknown auth mode: ${authMode}`)
      }
    }

    const makeDefault = yes(await ask(askIo, 'Set as default? [Y/n]: ') || 'y')

    setupProvider({ providerName, apiKey, apiKeyEnv, makeDefault })
    write(`Provider ${providerName} configured. Run "rivet provider list" to inspect.`)
    return {}
  } finally {
    rl?.close()
  }
}
