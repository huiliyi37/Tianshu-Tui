import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { runProviderConfigWizard } from '../provider-wizard.js'

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
})
