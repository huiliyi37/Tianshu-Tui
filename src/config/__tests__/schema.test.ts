import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agentSchema, configSchema, modelConfigSchema, workersSchema } from '../schema.js'
import { DEFAULT_CONFIG } from '../default.js'

describe('model supportsVision', () => {
  const base = { id: 'm', contextWindow: 128_000, maxTokens: 8_192 }

  it('defaults to undefined (text-only)', () => {
    const parsed = modelConfigSchema.parse(base)
    assert.equal(parsed.supportsVision, undefined)
  })

  it('parses an explicit supportsVision flag', () => {
    assert.equal(modelConfigSchema.parse({ ...base, supportsVision: true }).supportsVision, true)
    assert.equal(modelConfigSchema.parse({ ...base, supportsVision: false }).supportsVision, false)
  })

  it('rejects non-boolean supportsVision', () => {
    assert.throws(() => modelConfigSchema.parse({ ...base, supportsVision: 'yes' }))
  })

  it('preset vision models carry supportsVision=true through configSchema', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)
    const glm = parsed.provider.providers.glm?.models.find(m => m.id === 'glm-5.2')
    assert.equal(glm?.supportsVision, true)
    const deepseek = parsed.provider.providers.deepseek?.models.find(m => m.id === 'deepseek-v4-pro')
    assert.equal(deepseek?.supportsVision, undefined, 'text-only models stay undeclared')
  })
})

describe('config permissions schema', () => {
  it('defaults permissions.allow to an empty list', () => {
    const agent = agentSchema.parse({})

    assert.deepEqual(agent.permissions.allow, [])
  })

  it('parses permissions.allow tool and params entries', () => {
    const agent = agentSchema.parse({
      permissions: {
        allow: [
          { tool: 'read_file', params: { file_path: 'docs/*' } },
          { tool: 'bash', params: { command: 'git status*' } },
        ],
      },
    })

    assert.equal(agent.permissions.allow.length, 2)
    assert.equal(agent.permissions.allow[0]?.tool, 'read_file')
    assert.deepEqual(agent.permissions.allow[1]?.params, { command: 'git status*' })
  })

  it('keeps DEFAULT_CONFIG compatible with configSchema', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.deepEqual(parsed.agent.permissions.allow, [])
    assert.deepEqual(parsed.ui, {})
  })

  it('parses valid ui.theme values', () => {
    const parsed = configSchema.parse({
      ...DEFAULT_CONFIG,
      ui: { theme: 'ziwei' },
    })

    assert.equal(parsed.ui.theme, 'ziwei')
  })

  it('rejects invalid ui.theme values', () => {
    assert.throws(() =>
      configSchema.parse({
        ...DEFAULT_CONFIG,
        ui: { theme: 'neon-pink' },
      })
    )
  })

  it('parses dangerously-skip-permissions approval mode', () => {
    const agent = agentSchema.parse({ approval: 'dangerously-skip-permissions' })

    assert.equal(agent.approval, 'dangerously-skip-permissions')
  })

  it('includes Codex OAuth provider in DEFAULT_CONFIG', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.deepEqual(parsed.provider.providers.codex?.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(parsed.provider.providers.codex?.models[0]?.id, 'gpt-5.5')
  })

  it('keeps DEFAULT_CONFIG default provider and model specs valid', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.ok(parsed.provider.providers[parsed.provider.default])
    for (const [providerName, provider] of Object.entries(parsed.provider.providers)) {
      assert.ok(provider.models.length > 0, `${providerName} must have at least one model`)
      for (const model of provider.models) {
        assert.ok(model.contextWindow > 0, `${providerName}/${model.id} contextWindow must be positive`)
        assert.ok(model.maxTokens > 0, `${providerName}/${model.id} maxTokens must be positive`)
      }
    }
  })

  it('keeps worker profiles pointing to configured providers', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    for (const [profileName, profile] of Object.entries(parsed.workers.profiles)) {
      assert.ok(parsed.provider.providers[profile.provider], `${profileName} points to missing provider ${profile.provider}`)
    }
  })

  it('parses null API key tombstones as cleared optional fields', () => {
    const parsed = configSchema.parse({
      provider: {
        default: 'deepseek',
        providers: {
          deepseek: {
            ...DEFAULT_CONFIG.provider.providers.deepseek,
            apiKey: 'sk-inline',
            apiKeyEnv: null,
          },
        },
      },
    })

    assert.equal(parsed.provider.providers.deepseek?.apiKey, 'sk-inline')
    assert.equal(parsed.provider.providers.deepseek?.apiKeyEnv, undefined)
  })

  it('keeps Songline runtime disabled by default', () => {
    const agent = agentSchema.parse({})
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.equal(agent.songlineEnabled, false)
    assert.equal(parsed.agent.songlineEnabled, false)
    assert.equal(agent.antiAnchoring.enabled, false)
    assert.equal(parsed.agent.antiAnchoring.enabled, false)
    assert.equal(agent.intentRetrievalRouter.enabled, true)
    assert.equal(parsed.agent.intentRetrievalRouter.enabled, true)
  })

  it('parses explicit Songline runtime opt-in', () => {
    const agent = agentSchema.parse({ songlineEnabled: true })

    assert.equal(agent.songlineEnabled, true)
  })

  it('parses explicit anti-anchoring runtime opt-in with defaults', () => {
    const agent = agentSchema.parse({ antiAnchoring: { enabled: true } })

    assert.equal(agent.antiAnchoring.enabled, true)
    assert.equal(agent.antiAnchoring.blindExploration, true)
    assert.equal(agent.antiAnchoring.mctsPlanning, false)
    assert.equal(agent.antiAnchoring.branches, 3)
  })

  it('parses explicit intent retrieval router opt-in and boolean shorthand', () => {
    const fromBoolean = agentSchema.parse({ intentRetrievalRouter: true })
    const fromObject = agentSchema.parse({ intentRetrievalRouter: { enabled: true, classifier: 'heuristic', timeoutMs: 123 } })

    assert.equal(fromBoolean.intentRetrievalRouter.enabled, true)
    assert.equal(fromBoolean.intentRetrievalRouter.classifier, 'heuristic')
    assert.equal(fromBoolean.intentRetrievalRouter.timeoutMs, 4_000)
    assert.equal(fromObject.intentRetrievalRouter.enabled, true)
    assert.equal(fromObject.intentRetrievalRouter.classifier, 'heuristic')
    assert.equal(fromObject.intentRetrievalRouter.timeoutMs, 123)
  })

  it('keeps LLM speculation disabled by default and parses opt-in shorthand', () => {
    const agent = agentSchema.parse({})
    const parsed = configSchema.parse(DEFAULT_CONFIG)
    assert.equal(agent.llmSpeculation.enabled, false)
    assert.equal(parsed.agent.llmSpeculation.enabled, false)
    assert.equal(agent.llmSpeculation.slowToolsOnly, true)

    const fromBoolean = agentSchema.parse({ llmSpeculation: true })
    assert.equal(fromBoolean.llmSpeculation.enabled, true)
    assert.equal(fromBoolean.llmSpeculation.maxPerTurn, 3)

    const fromObject = agentSchema.parse({ llmSpeculation: { enabled: true, maxPerTurn: 5, timeoutMs: 500 } })
    assert.equal(fromObject.llmSpeculation.enabled, true)
    assert.equal(fromObject.llmSpeculation.maxPerTurn, 5)
    assert.equal(fromObject.llmSpeculation.timeoutMs, 500)
    assert.equal(fromObject.llmSpeculation.maxTokens, 320)
  })

  it('routes repo summarization workers to V4 Flash by default', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.equal(parsed.workers.routing.repo_summarization, 'cheap-flash')
    assert.equal(parsed.workers.profiles['cheap-flash']?.provider, 'deepseek')
    assert.equal(parsed.workers.profiles['cheap-flash']?.model, 'deepseek-v4-flash')
  })

  it('fills missing worker routing defaults with cheap-flash for repo summarization', () => {
    const parsed = workersSchema.parse({
      profiles: {
        'cheap-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' },
        capable: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      },
    })

    assert.equal(parsed.routing.repo_summarization, 'cheap-flash')
    assert.equal(parsed.routing.code_edit, 'cheap-flash')
  })

  it('routes the planning model to the strong tier, all other workers to cheap-flash', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    // 规划模型独立路由：planning 走强档（base planner 产出即执行分片图，
    // 规划质量决定并行拆分好坏）。其余 worker 任务仍全部走 cheap-flash。
    assert.equal(parsed.workers.routing.planning, 'capable')

    for (const [task, profile] of Object.entries(parsed.workers.routing)) {
      if (task === 'planning') continue
      assert.equal(profile, 'cheap-flash', `${task} should route to cheap-flash, got ${profile}`)
    }
  })
})

describe('pro schema', () => {
  it('DEFAULT_CONFIG keeps Pro disabled for the free tier, with features ready once Pro activates', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    // 双层模式：免费层的保护是 enabled=false（isProEnabled gate 一票否决）。
    // features 默认 true —— Pro 激活（许可证/RIVET_PRO）即全部可用，无需逐项手开。
    assert.equal(parsed.pro.enabled, false)
    assert.equal(parsed.pro.features.computerUse, true)
    assert.equal(parsed.pro.features.chatGateway, true)
    assert.equal(parsed.pro.features.teamMax, true)
    assert.equal(parsed.pro.features.councilMultiRound, true)
  })

  it('schema defaults Pro features to enabled when Pro is active', () => {
    const parsed = configSchema.parse({
      ...DEFAULT_CONFIG,
      pro: { enabled: true },
    })

    assert.equal(parsed.pro.enabled, true)
    assert.equal(parsed.pro.features.computerUse, true)
    assert.equal(parsed.pro.features.chatGateway, true)
  })

  it('parses explicit Pro opt-in and per-feature overrides', () => {
    const parsed = configSchema.parse({
      ...DEFAULT_CONFIG,
      pro: {
        enabled: true,
        licenseKey: 'test-key',
        features: { computerUse: false, chatGateway: true },
      },
    })

    assert.equal(parsed.pro.enabled, true)
    assert.equal(parsed.pro.licenseKey, 'test-key')
    assert.equal(parsed.pro.features.computerUse, false)
    assert.equal(parsed.pro.features.chatGateway, true)
  })
})
