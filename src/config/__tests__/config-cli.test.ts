import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, runConfigCLI, type ConfigCliIO } from '../manager.js'

function makeIo() {
  const stdout: string[] = []
  const stderr: string[] = []
  const exits: number[] = []
  const io: ConfigCliIO = {
    isTTY: false,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    exit: (code: number) => exits.push(code),
  }
  return { stdout, stderr, exits, io }
}

describe('runConfigCLI provider commands', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-config-cli-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints help instead of prompting when config has no args in non-TTY', async () => {
    const { stdout, exits, io } = makeIo()
    await runConfigCLI([], io)
    assert.equal(exits.length, 0)
    assert.match(stdout.join('\n'), /Usage: rivet config <command>/)
    assert.match(stdout.join('\n'), /setup <provider>/)
  })

  it('runs provider wizard when config has no args in TTY', async () => {
    const { stdout, exits, io } = makeIo()
    let wizardRuns = 0
    await runConfigCLI([], { ...io, isTTY: true, runWizard: async () => { wizardRuns++ } })
    assert.equal(wizardRuns, 1)
    assert.equal(exits.length, 0)
    assert.equal(stdout.join('\n'), '')
  })

  it('setup updates provider url, env key, model, and default', async () => {
    const { io } = makeIo()
    await runConfigCLI(['setup', 'minimax', '--key-env', 'MY_MINIMAX_KEY', '--url', 'https://proxy.example.com/v1', '--model', 'MiniMax-M2.8', '--alias', 'm28', '--context-window', '300000', '--max-tokens', '64000', '--default'], io)
    const config = loadConfig()
    const provider = config.provider.providers.minimax!
    assert.equal(config.provider.default, 'minimax')
    assert.equal(provider.apiKeyEnv, 'MY_MINIMAX_KEY')
    assert.equal(provider.baseUrl, 'https://proxy.example.com/v1')
    assert.equal(provider.models[0]?.id, 'MiniMax-M2.8')
    assert.equal(provider.models[0]?.alias, 'm28')
  })

  it('set-url and set-model update existing provider', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-url', 'deepseek', 'https://deepseek-proxy.example.com/v1'], io)
    await runConfigCLI(['set-model', 'deepseek', 'deepseek-custom', '500000', '32000', 'custom'], io)
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.baseUrl, 'https://deepseek-proxy.example.com/v1')
    assert.equal(provider.models[0]?.id, 'deepseek-custom')
    assert.equal(provider.models[0]?.alias, 'custom')
  })

  it('set-approval updates global approval mode', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-approval', 'dangerously-skip-permissions'], io)

    assert.equal(loadConfig().agent.approval, 'dangerously-skip-permissions')
    assert.match(stdout.join('\n'), /Approval mode set to dangerously-skip-permissions/)
  })

  it('rejects invalid approval modes', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-approval', 'unsafe'], io)

    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Invalid approval mode/)
  })

  it('rejects invalid numeric model parameters', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-model', 'deepseek', 'bad-model', 'not-a-number', '32000'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /context-window must be a positive integer/)
  })

  it('rejects setup flags that are missing values', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['setup', 'deepseek', '--key-env', '--default'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /--key-env requires a value/)
  })
})
