import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { parseModelSelection, runProviderConfigWizard } from '../provider-wizard.js'
import type { ProbeReport } from '../../api/provider-probe.js'

function scriptedIo(answers: string[]) {
  const lines: string[] = []
  const prompts: string[] = []
  return {
    lines,
    prompts,
    io: {
      write: (line: string) => lines.push(line),
      ask: async (question: string) => {
        prompts.push(question)
        return answers.shift() ?? ''
      },
    },
  }
}

function stubProbe(models: string[]): (options: unknown) => Promise<ProbeReport> {
  return async () => ({
    models,
    modelsOk: true,
    completionOk: true,
    hints: { reasoningSplit: true },
    errors: [],
  })
}

describe('provider config wizard', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-provider-wizard-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('configures an API-key provider with env auth and custom model', async () => {
    // 首问 'Configure now?' 答 Y 走配置流程
    const { prompts, io } = scriptedIo(['Y', 'minimax', 'env', 'MY_MINIMAX_KEY', 'https://proxy.example.com/v1', 'MiniMax-M2.8', 'm28', '300000', '64000', 'yes'])
    await runProviderConfigWizard(io)
    const config = loadConfig()
    const provider = config.provider.providers.minimax!
    assert.equal(config.provider.default, 'minimax')
    assert.equal(provider.apiKeyEnv, 'MY_MINIMAX_KEY')
    assert.equal(provider.baseUrl, 'https://proxy.example.com/v1')
    assert.equal(provider.models[0]?.id, 'MiniMax-M2.8')
    assert.ok(prompts.includes('Auth mode [inline|env|keep]: '))
    assert.ok(prompts.includes('API key env var: '))
  })

  it('configures codex without asking for api key', async () => {
    const { prompts, io } = scriptedIo(['Y', 'codex', '', '', '', '', '', 'yes'])
    await runProviderConfigWizard(io)
    const provider = loadConfig().provider.providers.codex!
    assert.deepEqual(provider.auth, { type: 'oauth', provider: 'codex' })
    const promptText = prompts.join('\n')
    assert.equal(promptText.includes('Auth mode'), false)
    assert.equal(promptText.includes('API key'), false)
  })

  it('returns { skipped: true } and does not modify config when user skips', async () => {
    const configBefore = loadConfig()
    const { lines, io } = scriptedIo(['n'])  // 选 n = 跳过
    const result = await runProviderConfigWizard(io)
    assert.equal(result.skipped, true)
    // config 没被改动
    assert.deepEqual(loadConfig(), configBefore)
    // 输出含配 key 的指引
    assert.ok(lines.some(l => l.includes('rivet config setup')), '应提示手动配置命令')
    assert.ok(lines.some(l => l.includes('DEEPSEEK_API_KEY')), '应提示环境变量备选')
  })

  it('skips by default on empty Enter (降低首启摩擦)', async () => {
    // 空回车 = 跳过（默认 n）
    const result = await runProviderConfigWizard(scriptedIo(['']).io)
    assert.equal(result.skipped, true)
  })

  it('custom path: probe-first onboarding registers probed models via the unified core', async () => {
    const { lines, io } = scriptedIo([
      'Y',                        // configure now
      'custom',                   // provider choice
      'https://relay.example.com/v1', // base url
      'sk-relay',                 // api key
      '1',                        // select first model only
      '',                         // provider name → host-derived default
      '',                         // default? Enter = yes
    ])
    await runProviderConfigWizard({ ...io, probe: stubProbe(['deepseek-v4-pro', 'mystery-model']) })

    const config = loadConfig()
    const provider = config.provider.providers['relay-example-com']!
    assert.ok(provider, 'host-derived provider name registered')
    assert.equal(config.provider.default, 'relay-example-com')
    assert.equal(provider.baseUrl, 'https://relay.example.com/v1')
    assert.equal(provider.apiKey, 'sk-relay')
    // Only the selected model lands; alias-table metadata backfilled.
    assert.equal(provider.models.length, 1)
    assert.equal(provider.models[0]!.id, 'deepseek-v4-pro')
    assert.equal(provider.models[0]!.contextWindow, 1_000_000)
    // Probe output surfaced to the user.
    assert.ok(lines.some(l => l.includes('2 model(s)')))
    assert.ok(lines.some(l => l.includes('reasoning_content')))
  })

  it('custom path: empty selection aborts without writing config', async () => {
    const { io } = scriptedIo([
      'Y',
      'custom',
      'https://relay.example.com/v1',
      '',
      '99', // out-of-range selection → nothing picked
    ])
    await assert.rejects(
      runProviderConfigWizard({ ...io, probe: stubProbe(['some-model']) }),
      /No models selected/,
    )
    assert.equal(loadConfig().provider.providers['relay-example-com'], undefined)
  })

  it('custom path: rejects a built-in preset name', async () => {
    const { io } = scriptedIo([
      'Y',
      'custom',
      'https://relay.example.com/v1',
      '',
      '',          // all models
      'deepseek',  // preset name
    ])
    await assert.rejects(
      runProviderConfigWizard({ ...io, probe: stubProbe(['some-model']) }),
      /built-in preset name/,
    )
  })

  it('custom path: endpoint without a model list falls back to manual model id', async () => {
    const { io } = scriptedIo([
      'Y',
      'custom',
      'https://relay.example.com/v1',
      '',
      'my-local-model', // manual model id
      'local-box',      // name
      'n',              // not default
    ])
    await runProviderConfigWizard({ ...io, probe: async () => ({ models: [], modelsOk: false, completionOk: true, hints: {}, errors: [] }) })
    const provider = loadConfig().provider.providers['local-box']!
    assert.equal(provider.models[0]!.id, 'my-local-model')
    // schema materialization filled the sizes.
    assert.equal(provider.models[0]!.contextWindow, 131_072)
  })
})

describe('parseModelSelection', () => {
  it('empty answer selects all', () => {
    assert.deepEqual(parseModelSelection('', 3), [0, 1, 2])
  })
  it('parses singles, ranges and dedupes', () => {
    assert.deepEqual(parseModelSelection('1,3-5,3', 6), [0, 2, 3, 4])
  })
  it('ignores out-of-range entries', () => {
    assert.deepEqual(parseModelSelection('0,7,2', 3), [1])
  })
  it('accepts Chinese comma and whitespace separators', () => {
    assert.deepEqual(parseModelSelection('1，3 4', 4), [0, 2, 3])
  })
})
