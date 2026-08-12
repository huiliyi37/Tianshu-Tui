import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadConfig,
  setupProvider,
  registerProvider,
  addProvider,
  addModel,
  updateProviderBaseUrl,
  upsertProviderModel,
  setApiKey,
  setApiKeyEnv,
  setDefaultProvider,
  removeProvider,
  runConfigCLI,
  setModelSupportsVision,
} from '../manager.js'
import { DEFAULT_CONFIG } from '../default.js'

describe('provider config mutations', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-provider-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets baseUrl without changing models', () => {
    updateProviderBaseUrl('deepseek', 'https://gateway.example.com/v1')
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.baseUrl, 'https://gateway.example.com/v1')
    assert.equal(provider.models[0]?.id, 'deepseek-v4-pro')
  })

  it('upserts a model and makes it preferred', () => {
    upsertProviderModel('deepseek', { id: 'deepseek-custom', alias: 'custom', contextWindow: 200000, maxTokens: 32000 }, { preferred: true })
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.models[0]?.id, 'deepseek-custom')
    upsertProviderModel('deepseek', { id: 'deepseek-custom', alias: 'custom2', contextWindow: 300000, maxTokens: 64000 }, { preferred: true })
    assert.equal(loadConfig().provider.providers.deepseek!.models.filter(m => m.id === 'deepseek-custom').length, 1)
    assert.equal(loadConfig().provider.providers.deepseek!.models[0]?.alias, 'custom2')
  })

  it('clamps maxTokens to the context window on upsert (mis-config backstop)', () => {
    upsertProviderModel('deepseek', { id: 'over-cfg', alias: 'over', contextWindow: 128000, maxTokens: 1000000 })
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'over-cfg')!
    assert.equal(model.contextWindow, 128000)
    assert.equal(model.maxTokens, 128000)
  })

  it('clamps maxTokens via setupProvider model option too', () => {
    setupProvider({ providerName: 'deepseek', model: { id: 'over-setup', alias: 'over2', contextWindow: 64000, maxTokens: 500000 } })
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'over-setup')!
    assert.equal(model.maxTokens, 64000)
  })

  it('sets apiKey and apiKeyEnv as mutually exclusive sources', () => {
    setApiKey('minimax', 'sk-inline')
    const inlineProvider = loadConfig().provider.providers.minimax!
    assert.equal(inlineProvider.apiKey, 'sk-inline')
    assert.equal(inlineProvider.apiKeyEnv, undefined)
    setApiKeyEnv('minimax', 'MINIMAX_API_KEY')
    const provider = loadConfig().provider.providers.minimax!
    assert.equal(provider.apiKey, undefined)
    assert.equal(provider.apiKeyEnv, 'MINIMAX_API_KEY')
  })

  it('setupProvider creates codex from preset and makes it default', () => {
    setupProvider({ providerName: 'codex', preset: 'codex', makeDefault: true })
    const config = loadConfig()
    assert.equal(config.provider.default, 'codex')
    assert.deepEqual(config.provider.providers.codex!.auth, { type: 'oauth', provider: 'codex' })
  })

  it('registerProvider materializes a full OpenAI-wire provider and makes it default', () => {
    registerProvider({
      providerName: 'custom-my-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-custom',
      models: [{ id: 'my-model', alias: 'mine', contextWindow: 1_000_000, maxTokens: 2_000_000 }],
      makeDefault: true,
    })
    const config = loadConfig()
    const provider = config.provider.providers['custom-my-model']!
    assert.equal(config.provider.default, 'custom-my-model')
    assert.equal(provider.baseUrl, 'https://api.example.com/v1')
    assert.equal(provider.apiKey, 'sk-custom')
    assert.equal(provider.protocol, 'openai')
    assert.equal(provider.models[0]?.id, 'my-model')
    assert.equal(provider.models[0]?.contextWindow, 1_000_000)
    // Output tokens are capped to the context window.
    assert.equal(provider.models[0]?.maxTokens, 1_000_000)
    // No hardcoded capability boilerplate — undeclared fields fall through to
    // DEFAULT_CAPABILITIES in resolveCapabilities.
    assert.deepEqual(provider.capabilities, {})
  })

  it('registerProvider honors an explicit protocol option', () => {
    registerProvider({
      providerName: 'custom-anthropic-wire',
      baseUrl: 'https://claude.example.com',
      apiKey: 'sk-custom',
      protocol: 'anthropic',
      models: [{ id: 'claude-sonnet', contextWindow: 200_000, maxTokens: 32_000 }],
    })
    const provider = loadConfig().provider.providers['custom-anthropic-wire']!
    assert.equal(provider.protocol, 'anthropic')
  })

  // The desktop Settings edit form submits only {id, alias, contextWindow,
  // maxTokens}. Whole-object replacement used to wipe everything else, and all
  // three losses are silent (images dropped / tier guessed from the name / cost
  // reads zero). A model absent from any preset isolates the merge from the
  // preset backfill, which would otherwise refill the fields on load.
  it('merges a partial model update instead of replacing the stored entry', () => {
    upsertProviderModel('deepseek', {
      id: 'house-model',
      contextWindow: 200000,
      maxTokens: 32000,
      supportsVision: true,
      tier: 'strong',
      pricing: { input: 1, output: 2 },
      reasoningEffort: 'high',
    })
    setupProvider({ providerName: 'deepseek', model: { id: 'house-model', contextWindow: 200000, maxTokens: 64000 } })
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'house-model')!
    assert.equal(model.maxTokens, 64000, 'the edit itself must land')
    assert.equal(model.supportsVision, true)
    assert.equal(model.tier, 'strong')
    assert.deepEqual(model.pricing, { input: 1, output: 2 })
    assert.equal(model.reasoningEffort, 'high')
  })

  it('merges partial updates on the upsert path too', () => {
    upsertProviderModel('deepseek', { id: 'house-2', contextWindow: 128000, maxTokens: 8000, supportsVision: true, tier: 'cheap' })
    upsertProviderModel('deepseek', { id: 'house-2', contextWindow: 128000, maxTokens: 16000 })
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'house-2')!
    assert.equal(model.maxTokens, 16000)
    assert.equal(model.supportsVision, true)
    assert.equal(model.tier, 'cheap')
  })

  it('lets an explicit value override the stored one (merge is not one-way)', () => {
    upsertProviderModel('deepseek', { id: 'house-3', contextWindow: 128000, maxTokens: 8000, supportsVision: true, tier: 'strong' })
    upsertProviderModel('deepseek', { id: 'house-3', contextWindow: 128000, maxTokens: 8000, supportsVision: false, tier: 'cheap' })
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'house-3')!
    assert.equal(model.supportsVision, false)
    assert.equal(model.tier, 'cheap')
  })

  it('registerProvider rejects an invalid base URL', () => {
    assert.throws(() => registerProvider({
      providerName: 'custom-bad',
      baseUrl: 'not-a-url',
      apiKey: 'sk',
      models: [{ id: 'm', contextWindow: 1000, maxTokens: 500 }],
    }))
  })

  it('removeProvider refuses to delete the default provider (deepseek)', () => {
    // deepseek 是默认 provider——default 保护拦截（预设名拦截已放开：
    // 删除预设名条目后 unconfigured 卡片回归，随时可重新配置）
    assert.throws(
      () => removeProvider('deepseek'),
      /cannot remove default provider "deepseek"/i,
    )
  })

  it('removeProvider removes the user-layer entry of a built-in preset name (defaults re-fill on load)', () => {
    // deepseek 在 DEFAULT_CONFIG 内置——loadConfig 的 4 层合并会在用户层删除后
    // 回填出厂预设，因此列表仍显示出厂 deepseek。验证删除动作到达用户层（磁盘）：
    // 用户配置中不应再有 deepseek 条目。
    setDefaultProvider('kimi')
    removeProvider('deepseek')
    const raw = JSON.parse(readFileSync(process.env.RIVET_CONFIG_PATH!, 'utf-8'))
    assert.equal(raw.provider.providers['deepseek'], undefined)
    // 出厂回填：合并视图里 deepseek 仍在（预设 clone）
    assert.equal(loadConfig().provider.providers['deepseek']?.apiKeyEnv, 'DEEPSEEK_API_KEY')
  })

  it('removeProvider allows deleting a legacy custom provider whose name collides with a preset', () => {
    // 历史死锁：setupCustomProvider 曾允许用预设名创建条目，删除时被按名字拦截
    // （Cannot remove preset provider）。存量撞名条目用 addProvider 构造，修复后应可删除。
    addProvider('zhipu-vision', {
      name: 'zhipu-vision',
      baseUrl: 'https://custom.example.com/v1',
      apiKey: 'sk-legacy',
      protocol: 'openai',
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
      thinking: 'enabled',
      maxTokens: 8000,
      allowProFallback: false,
      models: [{ id: 'custom-model', contextWindow: 128000, maxTokens: 8000 }],
      unsupported: [],
    })
    removeProvider('zhipu-vision')
    assert.equal(loadConfig().provider.providers['zhipu-vision'], undefined)
  })

  it('registerProvider rejects built-in preset names', () => {
    // zhipu-vision 是预设 key 但不在默认 providers map——修复前 setupCustomProvider
    // 会成功创建（死锁入口），修复后源头拦截
    assert.throws(
      () => registerProvider({
        providerName: 'zhipu-vision',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk',
        models: [{ id: 'm', contextWindow: 1000, maxTokens: 500 }],
      }),
      /built-in preset name/i,
    )
  })

  it('removeProvider allows deleting a custom provider', () => {
    registerProvider({
      providerName: 'custom-deletable',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-temp',
      models: [{ id: 'temp-model', contextWindow: 128000, maxTokens: 32000 }],
    })
    removeProvider('custom-deletable')
    const providers = loadConfig().provider.providers
    assert.equal(providers['custom-deletable'], undefined)
  })

  it('registerProvider throws when a provider with the same name already exists', () => {
    registerProvider({
      providerName: 'dup-test',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-1',
      models: [{ id: 'm1', contextWindow: 128000, maxTokens: 32000 }],
    })
    assert.throws(
      () => registerProvider({
        providerName: 'dup-test',
        baseUrl: 'https://api.other.com/v1',
        apiKey: 'sk-2',
        models: [{ id: 'm2', contextWindow: 64000, maxTokens: 16000 }],
      }),
      /already exists.*(use|to) edit/i,
    )
  })

  it('CLI `remove-provider` removes a custom provider', async () => {
    // 先创建一个自定义 provider，再通过 CLI 删除它
    registerProvider({
      providerName: 'cli-remove-me',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-temp',
      models: [{ id: 'temp-model', contextWindow: 128000, maxTokens: 32000 }],
    })
    const out: string[] = []
    const io = {
      isTTY: false,
      stdout: (l: string) => out.push(l),
      stderr: () => {},
      exit: () => {},
    }
    await runConfigCLI(['remove-provider', 'cli-remove-me'], io)
    const providers = loadConfig().provider.providers
    assert.equal(providers['cli-remove-me'], undefined)
  })

  // 回归闸：preset 视觉模型（glm-5.2）取消勾选时若 delete 字段，preset backfill
  // 会把缺席当成"没表态"回灌 true——用户下次启动看到勾选自己跳回来。
  it('unchecking vision on a preset model survives reload (backfill must not re-fill it)', () => {
    setModelSupportsVision('glm', 'glm-5.2', false)
    const model = loadConfig().provider.providers.glm!.models.find(m => m.id === 'glm-5.2')!
    assert.equal(model.supportsVision, false, 'explicit false must not be overwritten by preset backfill')
  })

  it('setModelSupportsVision can toggle vision on and off', () => {
    setModelSupportsVision('deepseek', 'deepseek-v4-pro', true)
    assert.equal(loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'deepseek-v4-pro')!.supportsVision, true)
    setModelSupportsVision('deepseek', 'deepseek-v4-pro', false)
    assert.equal(loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'deepseek-v4-pro')!.supportsVision, false)
  })

  it('setModelSupportsVision rejects unknown provider or model', () => {
    assert.throws(() => setModelSupportsVision('ghost', 'x', true), /Provider "ghost" not found/)
    assert.throws(() => setModelSupportsVision('deepseek', 'ghost-model', true), /Model "ghost-model" not found/)
  })

  // userSaved —— 模型切换器只显示用户真正保存过的 provider，出厂预设舰队不进列表。
  it('built-in preset names start without userSaved', () => {
    const providers = loadConfig().provider.providers
    assert.equal(providers.deepseek!.userSaved, undefined)
    assert.equal(providers.glm!.userSaved, undefined)
  })

  it('write paths stamp userSaved on the provider', () => {
    setupProvider({ providerName: 'deepseek' })
    assert.equal(loadConfig().provider.providers.deepseek!.userSaved, true)

    upsertProviderModel('glm', { id: 'glm-custom', contextWindow: 128000, maxTokens: 8000 })
    assert.equal(loadConfig().provider.providers.glm!.userSaved, true)

    registerProvider({
      providerName: 'custom-saved',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-saved',
      models: [{ id: 'm-saved', contextWindow: 128000, maxTokens: 32000 }],
    })
    assert.equal(loadConfig().provider.providers['custom-saved']!.userSaved, true)
  })

  it('loadConfig marks non-default provider names from the config file as userSaved', () => {
    writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify({
      provider: {
        providers: {
          'my-relay': {
            baseUrl: 'https://relay.example.com/v1',
            protocol: 'openai',
            models: [{ id: 'relay-model', contextWindow: 128000, maxTokens: 32000 }],
          },
        },
      },
    }))
    const providers = loadConfig().provider.providers
    assert.equal(providers['my-relay']!.userSaved, true)
    // 内置名未被用户文件触碰 → 依旧无标记。
    assert.equal(providers.deepseek!.userSaved, undefined)
  })

  it('addModel sets userSaved=true on the provider', () => {
    writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(DEFAULT_CONFIG))
    addProvider('my-relay', { name: 'my-relay', baseUrl: 'https://relay.example.com/v1', protocol: 'openai', capabilities: { thinkingBlock: 'none', effortFormat: 'none', prefixCache: 'none', prefixCompletion: false, toolJsonBug: false, cacheControl: false }, maxTokens: 4096 } as any)
    addModel('my-relay', { id: 'relay-v1', contextWindow: 16384, maxTokens: 8192 })
    const providers = loadConfig().provider.providers
    assert.equal(providers['my-relay']!.userSaved, true)
  })

  it('addProvider inline sets userSaved=true on the constructed provider', () => {
    writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(DEFAULT_CONFIG))
    addProvider('my-new-provider', {
      name: 'my-new-provider',
      baseUrl: 'https://example.com/v1',
      protocol: 'openai',
      capabilities: { thinkingBlock: 'none', effortFormat: 'none', prefixCache: 'none', prefixCompletion: false, toolJsonBug: false, cacheControl: false },
      maxTokens: 4096,
    } as any)
    const providers = loadConfig().provider.providers
    assert.equal(providers['my-new-provider']!.userSaved, true)
  })
})
