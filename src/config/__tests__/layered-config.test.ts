import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadConfig, loadConfigDefault, findProjectConfig } from '../manager.js'
import { DEFAULT_CONFIG } from '../default.js'
import { agentSchema } from '../schema.js'

describe('loadConfig — 3-layer resolution', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'rivet-config-test-'))

  it('DEFAULT_CONFIG.agent.maxTurns matches schema default (drift guard)', () => {
    // DEFAULT_CONFIG is deep-merged before schema.parse, so its explicit values
    // shadow the Zod .default(). If these drift, the schema default is dead code
    // (session 5158719d: schema said 200 but DEFAULT_CONFIG pinned 50 → no effect).
    const schemaDefault = agentSchema.shape.maxTurns._def.defaultValue()
    assert.equal(DEFAULT_CONFIG.agent.maxTurns, schemaDefault,
      'DEFAULT_CONFIG.agent.maxTurns must match schema default — drift makes the schema value dead')
  })

  it('DEFAULT_CONFIG.agent.checkpointEveryTurns matches schema default (drift guard, C3)', () => {
    const schemaDefault = agentSchema.shape.checkpointEveryTurns._def.defaultValue()
    assert.equal(DEFAULT_CONFIG.agent.checkpointEveryTurns, schemaDefault,
      'DEFAULT_CONFIG.agent.checkpointEveryTurns must match schema default — drift makes the schema value dead')
  })

  // ── C3 legacy migration: persisted checkpointEveryTurns=10 (old default)
  // without an autonomyBrake field is unmigrated legacy → new default 0 (off).
  // RIVET_CONFIG_PATH is pinned to an isolated temp file so the developer's
  // real ~/.rivet/config.json can't leak into the assertions. ──

  function withIsolatedUserConfig(userConfig: unknown, fn: () => void): void {
    const userCfgPath = join(tempDir, `user-config-${Math.random().toString(36).slice(2)}.json`)
    if (userConfig !== undefined) writeFileSync(userCfgPath, JSON.stringify(userConfig))
    const prev = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_CONFIG_PATH = userCfgPath
    try {
      fn()
    } finally {
      if (prev === undefined) delete process.env.RIVET_CONFIG_PATH
      else process.env.RIVET_CONFIG_PATH = prev
      rmSync(userCfgPath, { force: true })
    }
  }

  it('migrates legacy user-config checkpointEveryTurns=10 (no autonomyBrake) to the new default 0', () => {
    withIsolatedUserConfig({ agent: { checkpointEveryTurns: 10 } }, () => {
      const config = loadConfig()
      assert.equal(config.agent.checkpointEveryTurns, 0, 'legacy 10 is treated as unmigrated → schema default 0 (off)')
    })
  })

  it('migrates any checkpointEveryTurns=10 to the new default 0 (autonomyBrake removed)', () => {
    withIsolatedUserConfig({ agent: { checkpointEveryTurns: 10 } }, () => {
      const config = loadConfig()
      assert.equal(config.agent.checkpointEveryTurns, 0, '10 migrates to 0 since autonomyBrake field is gone')
    })
  })

  it('llmSpeculation defaults off and honors user-config opt-in override', () => {
    withIsolatedUserConfig(undefined, () => {
      const config = loadConfig()
      assert.equal(config.agent.llmSpeculation.enabled, false, 'llmSpeculation must default off')
    })
    withIsolatedUserConfig({ agent: { llmSpeculation: { enabled: true, maxPerTurn: 2 } } }, () => {
      const config = loadConfig()
      assert.equal(config.agent.llmSpeculation.enabled, true)
      assert.equal(config.agent.llmSpeculation.maxPerTurn, 2)
      assert.equal(config.agent.llmSpeculation.timeoutMs, 8_000, 'unset fields keep schema defaults')
    })
  })

  it('keeps explicitly tuned non-10 checkpoint intervals untouched', () => {
    withIsolatedUserConfig({ agent: { checkpointEveryTurns: 15 } }, () => {
      const config = loadConfig()
      assert.equal(config.agent.checkpointEveryTurns, 15)
    })
  })

  it('migrates legacy 10 in the project config layer too', () => {
    withIsolatedUserConfig(undefined, () => {
      const projectDir = join(tempDir, 'legacy-cp-project')
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, '.rivet-config.json'), JSON.stringify({
        agent: { checkpointEveryTurns: 10 },
      }))

      const config = loadConfig({ cwd: projectDir })
      assert.equal(config.agent.checkpointEveryTurns, 0)

      rmSync(projectDir, { recursive: true, force: true })
    })
  })

  it('applies project config over defaults', () => {
    const projectDir = join(tempDir, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '.rivet-config.json'), JSON.stringify({
      agent: { approval: 'manual', maxTurns: 10 },
    }))

    const config = loadConfig({ cwd: projectDir })
    assert.equal(config.agent.approval, 'manual')
    assert.equal(config.agent.maxTurns, 10)
    // Other defaults preserved
    assert.equal(config.agent.mode, 'code')

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('applies session overlay over project config', () => {
    const config = loadConfig({
      cwd: tempDir,
      sessionOverlay: {
        agent: { approval: 'auto-accept' },
      },
    })
    assert.equal(config.agent.approval, 'auto-accept')
  })

  it('applies Songline runtime opt-in from project config and session overlay', () => {
    const projectDir = join(tempDir, 'songline-project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '.rivet-config.json'), JSON.stringify({
      agent: { songlineEnabled: true },
    }))

    const projectConfig = loadConfig({ cwd: projectDir })
    assert.equal(projectConfig.agent.songlineEnabled, true)

    const overlayConfig = loadConfig({
      cwd: projectDir,
      sessionOverlay: { agent: { songlineEnabled: false } },
    })
    assert.equal(overlayConfig.agent.songlineEnabled, false)

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('uses explicit projectConfigPath when provided', () => {
    const customConfigPath = join(tempDir, 'custom-config.json')
    writeFileSync(customConfigPath, JSON.stringify({
      agent: { approval: 'suggest' },
    }))

    const config = loadConfig({ projectConfigPath: customConfigPath })
    assert.equal(config.agent.approval, 'suggest')

    rmSync(customConfigPath, { force: true })
  })

  it('gracefully skips malformed project config', () => {
    const projectDir = join(tempDir, 'malformed-project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '.rivet-config.json'), 'not valid json {{{')

    const config = loadConfig({ cwd: projectDir })
    // Falls back to global/user config (not default 'auto-safe' if user has custom config)
    assert.ok(['auto-accept', 'auto-safe', 'suggest', 'manual', 'dangerously-skip-permissions'].includes(config.agent.approval))

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('validates merged config through Zod schema', () => {
    const config = loadConfig({
      cwd: tempDir,
      sessionOverlay: {
        compact: { enabled: false },
      },
    })
    assert.equal(config.compact.enabled, false)
  })

  // Cleanup
  it('cleanup temp dir', () => {
    rmSync(tempDir, { recursive: true, force: true })
    assert.ok(true)
  })
})

describe('findProjectConfig', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'rivet-find-config-'))

  it('returns undefined when no config file exists', () => {
    const result = findProjectConfig(tempDir)
    assert.equal(result, undefined)
  })

  it('finds config in current directory', () => {
    writeFileSync(join(tempDir, '.rivet-config.json'), '{}')
    const result = findProjectConfig(tempDir)
    assert.ok(result)
    assert.ok(result!.endsWith('.rivet-config.json'))
    rmSync(join(tempDir, '.rivet-config.json'), { force: true })
  })

  it('finds config in parent directory', () => {
    const childDir = join(tempDir, 'child', 'grandchild')
    mkdirSync(childDir, { recursive: true })
    writeFileSync(join(tempDir, '.rivet-config.json'), '{}')

    const result = findProjectConfig(childDir)
    assert.ok(result)
    assert.ok(result!.includes(tempDir))

    rmSync(join(tempDir, '.rivet-config.json'), { force: true })
    rmSync(join(tempDir, 'child'), { recursive: true, force: true })
  })

  it('stops before reaching filesystem root', () => {
    // Starting from root should not infinite loop
    const result = findProjectConfig('/')
    // Just verify it returns something (undefined or a path) without hanging
    assert.ok(result === undefined || typeof result === 'string')
  })

  // Cleanup
  it('cleanup temp dir', () => {
    rmSync(tempDir, { recursive: true, force: true })
    assert.ok(true)
  })
})

describe('loadConfigDefault', () => {
  it('returns valid config without options', () => {
    const config = loadConfigDefault()
    assert.ok(config.provider)
    assert.ok(config.agent)
    assert.equal(typeof config.provider.default, 'string')
  })
})

describe('migrateDeepseekMaxTokens — one-shot bump 64000 → 384000', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'rivet-ds-migrate-test-'))

  function withIsolatedUserConfig(userConfig: unknown, fn: () => void): void {
    const userCfgPath = join(tempDir, `user-config-${Math.random().toString(36).slice(2)}.json`)
    if (userConfig !== undefined) writeFileSync(userCfgPath, JSON.stringify(userConfig))
    const prev = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_CONFIG_PATH = userCfgPath
    try {
      fn()
    } finally {
      if (prev === undefined) delete process.env.RIVET_CONFIG_PATH
      else process.env.RIVET_CONFIG_PATH = prev
      rmSync(userCfgPath, { force: true })
    }
  }

  it('bumps provider-level maxTokens from 64000 to 384000', () => {
    withIsolatedUserConfig({
      provider: { providers: { deepseek: { name: 'deepseek', maxTokens: 64000, models: [{ id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 64000 }] } } },
    }, () => {
      const config = loadConfig()
      const ds = config.provider.providers['deepseek']
      assert.ok(ds)
      assert.equal(ds.maxTokens, 384_000, 'provider-level maxTokens should be migrated to 384000')
    })
  })

  it('bumps per-model maxTokens from 64000 to 384000', () => {
    withIsolatedUserConfig({
      provider: {
        providers: {
          deepseek: {
            name: 'deepseek',
            maxTokens: 64000,
            models: [
              { id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 64000 },
              { id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 1_000_000, maxTokens: 64000 },
            ],
          },
        },
      },
    }, () => {
      const config = loadConfig()
      const ds = config.provider.providers['deepseek']
      assert.ok(ds)
      assert.equal(ds.maxTokens, 384_000)
      const models = ds.models
      assert.equal(models[0]?.maxTokens, 384_000, 'v4-pro model maxTokens should be migrated')
      assert.equal(models[1]?.maxTokens, 384_000, 'v4-flash model maxTokens should be migrated')
    })
  })

  it('leaves non-64000 values untouched', () => {
    withIsolatedUserConfig({
      provider: {
        providers: {
          deepseek: {
            name: 'deepseek',
            maxTokens: 128_000,
            models: [
              { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 128_000 },
            ],
          },
        },
      },
    }, () => {
      const config = loadConfig()
      const ds = config.provider.providers['deepseek']
      assert.ok(ds)
      assert.equal(ds.maxTokens, 128_000, 'explicit non-64000 should be preserved')
      assert.equal(ds.models[0]?.maxTokens, 128_000, 'explicit non-64000 model should be preserved')
    })
  })

  it('writes back migrated config to disk', () => {
    const userCfgPath = join(tempDir, `user-config-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(userCfgPath, JSON.stringify({
      provider: {
        providers: {
          deepseek: {
            name: 'deepseek',
            maxTokens: 64000,
            models: [
              { id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 64000 },
            ],
          },
        },
      },
    }))
    const prev = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_CONFIG_PATH = userCfgPath
    try {
      loadConfig()
      // Migration should have written back to disk
      const raw = JSON.parse(readFileSync(userCfgPath, 'utf-8'))
      const ds = raw?.provider?.providers?.deepseek
      assert.ok(ds)
      assert.equal(ds.maxTokens, 384_000, 'write-back: provider-level should be 384000')
      assert.equal(ds.models[0]?.maxTokens, 384_000, 'write-back: model-level should be 384000')
    } finally {
      if (prev === undefined) delete process.env.RIVET_CONFIG_PATH
      else process.env.RIVET_CONFIG_PATH = prev
      rmSync(userCfgPath, { force: true })
    }
  })

  it('does not crash when deepseek config is absent', () => {
    withIsolatedUserConfig({ agent: { maxTurns: 5 } }, () => {
      const config = loadConfig()
      assert.equal(config.agent.maxTurns, 5)
      // deepseek provider loaded from preset (DEFAULT_CONFIG)
      const ds = config.provider.providers['deepseek']
      assert.ok(ds)
      assert.equal(ds.maxTokens, 384_000, 'preset default should be used when no user override')
    })
  })

  it('no write-back when no migration needed', () => {
    const userCfgPath = join(tempDir, `user-config-${Math.random().toString(36).slice(2)}.json`)
    const original = {
      provider: {
        providers: {
          deepseek: {
            name: 'deepseek',
            maxTokens: 384_000,
            models: [
              { id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 384_000 },
            ],
          },
        },
      },
    }
    writeFileSync(userCfgPath, JSON.stringify(original))
    const prev = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_CONFIG_PATH = userCfgPath
    try {
      loadConfig()
      const raw = JSON.parse(readFileSync(userCfgPath, 'utf-8'))
      // Should be byte-identical (no unnecessary writes)
      assert.deepEqual(raw, original, 'no migration needed → file should be unchanged')
    } finally {
      if (prev === undefined) delete process.env.RIVET_CONFIG_PATH
      else process.env.RIVET_CONFIG_PATH = prev
      rmSync(userCfgPath, { force: true })
    }
  })

  // Cleanup
  it('cleanup temp dir', () => {
    rmSync(tempDir, { recursive: true, force: true })
    assert.ok(true)
  })
})
