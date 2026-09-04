import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, setApiKey, setApiKeyEnv, clearApiKey, getApiKeyStatus } from '../manager.js'
import { readSecret, secretsPath } from '../secrets-store.js'

describe('clearApiKey — 清 key 保留 provider', () => {
  let dir = ''
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-clear-api-key-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    // 标准环境变量回退（<NAME>_API_KEY）会污染 keyStatus 断言，测试内摘除。
    for (const k of ['DEEPSEEK_API_KEY', 'MY_TEST_PROVIDER_KEY']) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('清除后 secret 删除、provider 与模型保留（默认 provider 允许）', () => {
    setApiKey('deepseek', 'sk-first-install')
    assert.equal(readSecret('deepseek'), 'sk-first-install')

    const r = clearApiKey('deepseek')
    assert.equal(r.secretDeleted, true)
    assert.equal(r.keyStatus.source, 'none')
    assert.equal(readSecret('deepseek'), undefined)

    const provider = loadConfig().provider.providers.deepseek
    assert.ok(provider, 'provider 条目必须保留')
    assert.ok(provider.models.length > 0, '模型列表必须保留')
    assert.equal(loadConfig().provider.default, 'deepseek', 'default 指向不变')
  })

  it('清除后 keyRef / apiKey / apiKeyEnv 配置引用全部清空', () => {
    setApiKey('deepseek', 'sk-x')
    clearApiKey('deepseek')
    const raw = loadConfig().provider.providers.deepseek as Record<string, unknown>
    assert.equal(raw.keyRef ?? null, null)
    assert.equal(raw.apiKey ?? null, null)
    assert.equal(raw.apiKeyEnv ?? null, null)
  })

  it('显式 apiKeyEnv 一并清除；标准名环境变量仍在进程时如实报回 env', () => {
    // 用与标准回退同名的变量——清除 apiKeyEnv 后 <NAME>_API_KEY 回退仍会命中，
    // 这类 env 注入的 key 清不掉，keyStatus 必须如实报回让 UI 引导去系统侧处理。
    setApiKeyEnv('deepseek', 'DEEPSEEK_API_KEY')
    process.env.DEEPSEEK_API_KEY = 'from-env'
    assert.equal(getApiKeyStatus('deepseek').source, 'env')

    const r = clearApiKey('deepseek')
    assert.equal(r.secretDeleted, false, 'env 来源没有 secret 可删')
    assert.equal(r.keyStatus.source, 'env')
    assert.equal(r.keyStatus.ref, 'DEEPSEEK_API_KEY')

    delete process.env.DEEPSEEK_API_KEY
    assert.equal(getApiKeyStatus('deepseek').source, 'none')
  })

  it('清除自定义名 apiKeyEnv 后该 env 引用不可达（标准回退不覆盖自定义名）', () => {
    setApiKeyEnv('deepseek', 'MY_TEST_PROVIDER_KEY')
    process.env.MY_TEST_PROVIDER_KEY = 'from-env'

    const r = clearApiKey('deepseek')
    assert.equal(r.keyStatus.source, 'none', '自定义 env 名不在标准回退内，清除即不可达')
  })

  it('provider 不存在时抛错', () => {
    assert.throws(() => clearApiKey('no-such-provider'), /not found/i)
  })

  it('最后一个 keyRef 引用清除才删除 secrets 文件', () => {
    setApiKey('deepseek', 'sk-last-one')
    assert.ok(existsSync(secretsPath()), 'secret 文件应存在')
    clearApiKey('deepseek')
    assert.equal(existsSync(secretsPath()), false, '最后一个 key 删除后 secrets 文件应整体清理')
  })
})
