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
    const { prompts, io } = scriptedIo(['minimax', 'env', 'MY_MINIMAX_KEY', 'https://proxy.example.com/v1', 'MiniMax-M2.8', 'm28', '300000', '64000', 'yes'])
    await runProviderConfigWizard(io)
    const config = loadConfig()
    const provider = config.provider.providers.minimax!
    assert.equal(config.provider.default, 'minimax')
    assert.equal(provider.apiKeyEnv, 'MY_MINIMAX_KEY')
    assert.equal(provider.baseUrl, 'https://proxy.example.com/v1')
    assert.equal(provider.models[0]?.id, 'MiniMax-M2.8')
    assert.ok(prompts.includes('Auth mode [env|inline|keep]: '))
    assert.ok(prompts.includes('API key env var: '))
  })

  it('configures codex without asking for api key', async () => {
    const { prompts, io } = scriptedIo(['codex', '', '', '', '', '', 'yes'])
    await runProviderConfigWizard(io)
    const provider = loadConfig().provider.providers.codex!
    assert.deepEqual(provider.auth, { type: 'oauth', provider: 'codex' })
    const promptText = prompts.join('\n')
    assert.equal(promptText.includes('Auth mode'), false)
    assert.equal(promptText.includes('API key'), false)
  })
})
