import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, getVisionModelConfig, setVisionModelConfig } from '../manager.js'

describe('vision model config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-vision-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no vision model is configured', () => {
    assert.equal(getVisionModelConfig(), null)
  })

  it('persists provider + model and round-trips through loadConfig', () => {
    const saved = setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3' })
    assert.deepEqual(saved, { provider: 'minimax', model: 'MiniMax-M3', maxTokens: 1024 })
    assert.deepEqual(loadConfig().agent.visionModel, saved)
    assert.deepEqual(getVisionModelConfig(), saved)
  })

  it('persists optional prompt and maxTokens', () => {
    const saved = setVisionModelConfig({
      provider: 'glm',
      model: 'glm-5.2',
      prompt: 'Describe the screenshot in Chinese',
      maxTokens: 512,
    })
    assert.deepEqual(saved, {
      provider: 'glm',
      model: 'glm-5.2',
      prompt: 'Describe the screenshot in Chinese',
      maxTokens: 512,
    })
    assert.deepEqual(getVisionModelConfig(), saved)
  })

  it('clears the bridge when passed null', () => {
    setVisionModelConfig({ provider: 'glm', model: 'glm-5.2' })
    assert.equal(getVisionModelConfig()?.provider, 'glm')
    const cleared = setVisionModelConfig(null)
    assert.equal(cleared, null)
    assert.equal(loadConfig().agent.visionModel, undefined)
  })

  // fallback 的三态：省略=保留、null=清除、对象=设置。省略即保留是为了两个界面
  // （桌面端 / TUI 面板 / 手写配置）轮流写同一份配置时，后写的那个不会抹掉自己不
  // 显示的字段——早期整体替换让"保存一下别的项"就吞掉了备用识图桥。
  it('keeps an existing fallback when the payload omits it', () => {
    setVisionModelConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      fallback: { provider: 'glm', model: 'glm-5.2' },
    })
    const saved = setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3', maxTokens: 2048 })
    assert.deepEqual(saved?.fallback, { provider: 'glm', model: 'glm-5.2' }, '不提到它就不该删它')
    assert.equal(saved?.maxTokens, 2048)
  })

  it('clears the fallback only on an explicit null', () => {
    setVisionModelConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      fallback: { provider: 'glm', model: 'glm-5.2' },
    })
    const saved = setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3', fallback: null })
    assert.equal(saved?.fallback, undefined)
    assert.equal(loadConfig().agent.visionModel?.fallback, undefined)
  })

  it('replaces the fallback when a new one is given', () => {
    setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3', fallback: { provider: 'glm', model: 'glm-5.2' } })
    const saved = setVisionModelConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      fallback: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    })
    assert.deepEqual(saved?.fallback, { provider: 'deepseek', model: 'deepseek-v4-flash' })
  })

  it('rejects a malformed fallback instead of silently dropping it', () => {
    assert.throws(() => setVisionModelConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      fallback: { provider: 'glm' },
    }))
  })

  it('treats empty provider/model as a clear and rejects malformed payloads', () => {
    setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3' })
    assert.equal(getVisionModelConfig()?.provider, 'minimax')

    // Empty provider/model clears the bridge (UI "Clear" path).
    const cleared = setVisionModelConfig({ provider: '', model: 'MiniMax-M3' } as unknown as Record<string, unknown>)
    assert.equal(cleared, null)
    assert.equal(loadConfig().agent.visionModel, undefined)

    // Missing model or invalid maxTokens are rejected.
    assert.throws(() => setVisionModelConfig({ provider: 'minimax' } as unknown as Record<string, unknown>))
    assert.throws(() => setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3', maxTokens: 0 } as unknown as Record<string, unknown>))
  })

  // ── provider/model 存在性校验（断点 2 修复）──────────────────────────────
  // 此前 setVisionModelConfig 不校验 provider/model 存在，CLI 用户手编 provider 名
  // 但没 setup 该 provider 时，写盘成功，运行时 buildVisionClient 静默 warn 退出
  // （图片被丢），用户以为配了实际没生效。现在与 setDefaultModelConfig 对齐校验。

  it('rejects a vision provider that is not in provider.providers', () => {
    assert.throws(
      () => setVisionModelConfig({ provider: 'nonexistent-prov', model: 'some-model' }),
      /不在已配置的 provider 列表里/,
    )
    // 没写进 config
    assert.equal(loadConfig().agent.visionModel, undefined)
  })

  it('rejects a vision model that does not exist under the provider', () => {
    // minimax provider 存在，但 model 名拼错
    assert.throws(
      () => setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-TYPO' }),
      /没有模型 "MiniMax-TYPO"/,
    )
    assert.equal(loadConfig().agent.visionModel, undefined)
  })

  it('rejects a fallback provider/model that does not exist', () => {
    // 主桥合法，fallback 的 provider 不存在
    assert.throws(
      () => setVisionModelConfig({
        provider: 'minimax', model: 'MiniMax-M3',
        fallback: { provider: 'ghost-prov', model: 'ghost-model' },
      }),
      /备用视觉模型.*ghost-prov/,
    )
    // 主桥合法，fallback 的 model 不存在
    assert.throws(
      () => setVisionModelConfig({
        provider: 'minimax', model: 'MiniMax-M3',
        fallback: { provider: 'glm', model: 'glm-typo' },
      }),
      /备用视觉模型.*glm-typo/,
    )
    // 校验失败时整体不写盘（主桥也没进 config）
    assert.equal(loadConfig().agent.visionModel, undefined)
  })

  it('accepts alias as a valid model reference', () => {
    // glm-5.2 的 alias 是 m28（见 DEFAULT_CONFIG preset）——校验应认 alias
    const saved = setVisionModelConfig({ provider: 'glm', model: 'glm-5.2' })
    assert.equal(saved?.provider, 'glm')
  })
})
