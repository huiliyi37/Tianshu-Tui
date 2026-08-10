import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { runProviderConfigWizard } from '../provider-wizard.js'

function scriptedIo(answers: string[], secretAnswers: string[] = []) {
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
      askSecret: async (question: string) => {
        prompts.push(question)
        return secretAnswers.shift() ?? ''
      },
    },
  }
}

describe('provider config wizard (degraded readline path)', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-provider-wizard-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('configures a preset provider with env auth, no url/model questions', async () => {
    const { prompts, io } = scriptedIo(['Y', 'minimax', 'env', 'MY_MINIMAX_KEY', 'yes'])
    await runProviderConfigWizard(io)
    const config = loadConfig()
    const provider = config.provider.providers.minimax!
    assert.equal(config.provider.default, 'minimax')
    assert.equal(provider.apiKeyEnv, 'MY_MINIMAX_KEY')
    // Preset defaults land untouched — no Base URL / Model ID questions.
    const promptText = prompts.join('\n')
    assert.equal(promptText.includes('Base URL'), false)
    assert.equal(promptText.includes('Model ID'), false)
    assert.ok(provider.models.length > 0)
  })

  it('stores inline key via the masked input channel', async () => {
    const { prompts, io } = scriptedIo(['Y', 'deepseek', '', ''], ['sk-secret-123'])
    await runProviderConfigWizard(io)
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.apiKey, 'sk-secret-123')
    assert.ok(prompts.some(p => p.startsWith('API key (input hidden)')), 'key prompt must go through askSecret')
    assert.ok(!prompts.some(p => p === 'API key: '), 'plain key prompt must not appear')
  })

  it('configures codex without asking for api key', async () => {
    const { prompts, io } = scriptedIo(['Y', 'codex', ''])
    await runProviderConfigWizard(io)
    const provider = loadConfig().provider.providers.codex!
    assert.deepEqual(provider.auth, { type: 'oauth', provider: 'codex' })
    const promptText = prompts.join('\n')
    assert.equal(promptText.includes('Auth mode'), false)
    assert.equal(promptText.includes('API key'), false)
  })

  it('custom choice aborts and points at the probe-first CLI', async () => {
    const { lines, io } = scriptedIo(['Y', 'custom'])
    await assert.rejects(runProviderConfigWizard(io), /rivet provider add/)
    assert.ok(lines.some(l => l.includes('rivet provider add <name> --base-url')))
    // No provider got registered by the aborted custom attempt.
    assert.equal(loadConfig().provider.providers['relay-example-com'], undefined)
    assert.equal(loadConfig().provider.default, 'deepseek')
  })

  it('returns { skipped: true } and does not modify config when user skips', async () => {
    const configBefore = loadConfig()
    const { lines, io } = scriptedIo(['n'])  // 选 n = 跳过
    const result = await runProviderConfigWizard(io)
    assert.equal(result.skipped, true)
    assert.deepEqual(loadConfig(), configBefore)
    assert.ok(lines.some(l => l.includes('rivet config setup')), '应提示手动配置命令')
    assert.ok(lines.some(l => l.includes('DEEPSEEK_API_KEY')), '应提示环境变量备选')
  })

  it('skips by default on empty Enter (降低首启摩擦)', async () => {
    const result = await runProviderConfigWizard(scriptedIo(['']).io)
    assert.equal(result.skipped, true)
  })

  it('rejects unknown provider names', async () => {
    const { io } = scriptedIo(['Y', 'no-such-provider'])
    await assert.rejects(runProviderConfigWizard(io), /no built-in preset/)
  })
})
