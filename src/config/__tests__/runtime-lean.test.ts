import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isRuntimeLean,
  isRuntimeLeanForDomain,
  resolveDomainRuntimeConfig,
  resolveSessionPoolOptions,
  resolveLeanDefaults,
  validateRuntimeLeanSlice,
  MIN_MAX_LOADED_SESSIONS,
  MIN_IDLE_AGENT_TTL_MS,
  MIN_MAX_EVENTS_DISK_BYTES,
  LEAN_MAX_LOADED_SESSIONS,
  LEAN_IDLE_AGENT_TTL_MS,
  DEFAULT_MAX_LOADED_SESSIONS,
  DEFAULT_IDLE_AGENT_TTL_MS,
  LEAN_MAX_EVENTS_DISK_BYTES,
} from '../runtime-lean.js'
import { __resetToolPresetForTest, resolveToolPreset } from '../../tools/tool-preset.js'
import { invalidatePromptBlocks, resolvePromptBlocks } from '../../prompt/block-policy.js'
import { setRuntimeLeanConfig, getRuntimeLeanConfig } from '../manager.js'

const ENV_KEYS = ['RIVET_LEAN', 'RIVET_LEAN_AUTO', 'RIVET_TOOL_PRESET', 'RIVET_PROMPT_PROFILE', 'RIVET_CONFIG_PATH'] as const

describe('runtime-lean', () => {
  let saved: Array<string | undefined>
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-lean-'))
    saved = ENV_KEYS.map(k => process.env[k])
    for (const k of ENV_KEYS) delete process.env[k]
    // Isolate from real user config — resolveToolPreset/block-policy read it.
    process.env.RIVET_CONFIG_PATH = join(dir, 'nonexistent-config.json')
    __resetToolPresetForTest()
    invalidatePromptBlocks()
  })

  afterEach(() => {
    ENV_KEYS.forEach((k, i) => {
      const v = saved[i]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    })
    __resetToolPresetForTest()
    invalidatePromptBlocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('RIVET_LEAN=1 forces lean; =0 forces off over config', () => {
    process.env.RIVET_LEAN = '1'
    assert.equal(isRuntimeLean(false), true)
    process.env.RIVET_LEAN = '0'
    assert.equal(isRuntimeLean(true), false)
  })

  it('configLean true enables without env', () => {
    assert.equal(isRuntimeLean(true), true)
    assert.equal(isRuntimeLean(false), false)
  })

  it('RIVET_LEAN_AUTO 不再生效（2026-08-09 产品决策：不自动降级，改引导提醒）', () => {
    process.env.RIVET_LEAN_AUTO = '1'
    // 无显式 env / config 时 AUTO 也不得开启 lean
    assert.equal(isRuntimeLean(undefined), false, 'RIVET_LEAN_AUTO 已废弃，不得再触发 lean')
    // 显式 env / config 行为不变
    process.env.RIVET_LEAN = '1'
    assert.equal(isRuntimeLean(undefined), true)
  })

  it('lean expands tool preset to minimal when preset unset', () => {
    process.env.RIVET_LEAN = '1'
    assert.equal(resolveToolPreset(dir), 'minimal')
  })

  it('explicit tool preset wins over lean', () => {
    process.env.RIVET_LEAN = '1'
    process.env.RIVET_TOOL_PRESET = 'full'
    assert.equal(resolveToolPreset(dir), 'full')
  })

  it('lean expands prompt profile when unset', () => {
    process.env.RIVET_LEAN = '1'
    assert.equal(resolvePromptBlocks(dir).profile, 'lean')
  })

  it('explicit prompt profile wins over lean', () => {
    process.env.RIVET_LEAN = '1'
    process.env.RIVET_PROMPT_PROFILE = 'full'
    assert.equal(resolvePromptBlocks(dir).profile, 'full')
  })

  it('resolveSessionPoolOptions uses lean caps', () => {
    const lean = resolveSessionPoolOptions({}, true)
    assert.equal(lean.maxLoadedSessions, LEAN_MAX_LOADED_SESSIONS)
    assert.equal(lean.idleAgentTtlMs, LEAN_IDLE_AGENT_TTL_MS)
    assert.equal(lean.maxEventsDiskBytes, LEAN_MAX_EVENTS_DISK_BYTES)

    const normal = resolveSessionPoolOptions({}, false)
    assert.equal(normal.maxLoadedSessions, DEFAULT_MAX_LOADED_SESSIONS)
    assert.equal(normal.idleAgentTtlMs, DEFAULT_IDLE_AGENT_TTL_MS)

    const override = resolveSessionPoolOptions({ maxLoadedSessions: 2, idleAgentTtlMs: 1000 }, true)
    assert.equal(override.maxLoadedSessions, 2)
    assert.equal(override.idleAgentTtlMs, 1000)
  })

  it('reads runtime.lean from project config', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ runtime: { lean: true } }))
    mkdirSync(join(dir, 'src'), { recursive: true })
    assert.equal(isRuntimeLean(undefined, dir), true)
  })

  it('域覆盖：defaultDomain 钉定域时用 runtime.domains 值（taiyi 默认 lean）', () => {
    const runtime = {
      lean: false,
      domains: { taiyi: { lean: true, maxLoadedSessions: 4, toolPreset: 'taiyi' as const } },
    }
    assert.equal(isRuntimeLeanForDomain('taiyi', runtime), true)
    assert.equal(isRuntimeLeanForDomain('qiming', runtime), false, '其他域不受影响')
    assert.equal(isRuntimeLeanForDomain('auto', runtime), false, 'auto 回退全局')
    assert.equal(isRuntimeLeanForDomain(undefined, runtime), false)
    const cfg = resolveDomainRuntimeConfig('taiyi', runtime)
    assert.equal(cfg?.maxLoadedSessions, 4)
    assert.equal(cfg?.toolPreset, 'taiyi')
    assert.equal(resolveDomainRuntimeConfig('qiming', runtime), undefined, '无覆盖返回 undefined')
  })

  it('域覆盖：任意已注册域可进集合（changgeng 长庚参考 taiyi）', () => {
    const runtime = {
      lean: false,
      domains: { changgeng: { lean: true, toolPreset: 'taiyi' as const } },
    }
    assert.equal(isRuntimeLeanForDomain('changgeng', runtime), true)
    const cfg = resolveDomainRuntimeConfig('changgeng', runtime)
    assert.equal(cfg?.toolPreset, 'taiyi')
    // 集合互不影响：changgeng 配置后 taiyi/qiming 仍回退
    assert.equal(isRuntimeLeanForDomain('taiyi', runtime), false)
  })

  it('域覆盖：env 主开关恒优先于域配置', () => {
    const runtime = { lean: false, domains: { taiyi: { lean: true } } }
    process.env.RIVET_LEAN = '0'
    try {
      assert.equal(isRuntimeLeanForDomain('taiyi', runtime), false)
    } finally {
      delete process.env.RIVET_LEAN
    }
  })

  it('setRuntimeLeanConfig：domains 增量合并、删除、非法值校验', () => {
    // 写 taiyi 覆盖
    setRuntimeLeanConfig({ domains: { taiyi: { lean: true, toolPreset: 'taiyi', maxLoadedSessions: 4 } } })
    let cfg = getRuntimeLeanConfig()
    assert.deepEqual(cfg.domains?.taiyi, { lean: true, toolPreset: 'taiyi', maxLoadedSessions: 4 })

    // 增量更新：只改 lean 字段，其余保留
    setRuntimeLeanConfig({ domains: { taiyi: { lean: false } } })
    cfg = getRuntimeLeanConfig()
    assert.deepEqual(cfg.domains?.taiyi, { lean: false, toolPreset: 'taiyi', maxLoadedSessions: 4 })

    // 新增另一域不影响既有
    setRuntimeLeanConfig({ domains: { qiming: { lean: true } } })
    cfg = getRuntimeLeanConfig()
    assert.equal(cfg.domains?.taiyi?.toolPreset, 'taiyi')
    assert.equal(cfg.domains?.qiming?.lean, true)

    // 删除
    setRuntimeLeanConfig({ domains: { taiyi: null } })
    cfg = getRuntimeLeanConfig()
    assert.equal(cfg.domains?.taiyi, undefined)
    assert.equal(cfg.domains?.qiming?.lean, true)

    // 非法值
    assert.throws(() => setRuntimeLeanConfig({ domains: { taiyi: { maxLoadedSessions: 0 } } }), /maxLoadedSessions/)
    assert.throws(() => setRuntimeLeanConfig({ domains: { taiyi: { toolPreset: 'huge' } } }), /toolPreset/)
    assert.throws(() => setRuntimeLeanConfig({ domains: { taiyi: { maxEventsDiskBytes: 500 } } }), /maxEventsDiskBytes/)
  })
})

describe('resolveLeanDefaults（单一真相源）', () => {
  it('lean=true 返回收紧档（4/10min/10MB）', () => {
    const d = resolveLeanDefaults(true)
    assert.equal(d.maxLoadedSessions, LEAN_MAX_LOADED_SESSIONS)
    assert.equal(d.idleAgentTtlMs, LEAN_IDLE_AGENT_TTL_MS)
    assert.equal(d.maxEventsDiskBytes, LEAN_MAX_EVENTS_DISK_BYTES)
  })

  it('lean=false 返回正常档（16/30min/50MB）', () => {
    const d = resolveLeanDefaults(false)
    assert.equal(d.maxLoadedSessions, DEFAULT_MAX_LOADED_SESSIONS)
    assert.equal(d.idleAgentTtlMs, DEFAULT_IDLE_AGENT_TTL_MS)
  })

  it('与 resolveSessionPoolOptions(undefined, lean) 同口径', () => {
    // resolveSessionPoolOptions 缺省回落必须走 resolveLeanDefaults——保证
    // settings 面板显示值与运行时生效值一致（审查 HIGH 的根因防护）。
    for (const lean of [true, false]) {
      assert.deepEqual(resolveSessionPoolOptions(undefined, lean), resolveLeanDefaults(lean))
    }
  })
})

describe('validateRuntimeLeanSlice（下限单一真相源）', () => {
  it('合法值不抛（含缺省字段）', () => {
    assert.doesNotThrow(() => validateRuntimeLeanSlice({}))
    assert.doesNotThrow(() => validateRuntimeLeanSlice({ lean: true, maxLoadedSessions: MIN_MAX_LOADED_SESSIONS, idleAgentTtlMs: MIN_IDLE_AGENT_TTL_MS, maxEventsDiskBytes: MIN_MAX_EVENTS_DISK_BYTES }))
  })

  it('下限边界：恰好等于 MIN 通过', () => {
    assert.doesNotThrow(() => validateRuntimeLeanSlice({ maxLoadedSessions: 1 }))
    assert.doesNotThrow(() => validateRuntimeLeanSlice({ idleAgentTtlMs: 0 }))
    assert.doesNotThrow(() => validateRuntimeLeanSlice({ maxEventsDiskBytes: 1_000_000 }))
  })

  it('越界抛错且错误消息含字段名与下限', () => {
    assert.throws(() => validateRuntimeLeanSlice({ maxLoadedSessions: 0 }), /maxLoadedSessions must be an integer >= 1/)
    assert.throws(() => validateRuntimeLeanSlice({ idleAgentTtlMs: -1 }), /idleAgentTtlMs must be an integer >= 0/)
    // maxEventsDiskBytes 下限是反复漂移过的字段（UI min=1 vs 校验 1M）——
    // 显式断言下限 1_000_000，未来改动 MIN_MAX_EVENTS_DISK_BYTES 时测试会报错提醒。
    assert.throws(() => validateRuntimeLeanSlice({ maxEventsDiskBytes: 999_999 }), /maxEventsDiskBytes must be an integer >= 1000000/)
    assert.throws(() => validateRuntimeLeanSlice({ lean: 'yes' }), /lean must be a boolean/)
  })

  it('prefix 出现在错误消息里（域覆盖定位）', () => {
    assert.throws(
      () => validateRuntimeLeanSlice({ maxLoadedSessions: 0 }, 'domains.changgeng'),
      /domains\.changgeng\.maxLoadedSessions/,
    )
  })

  it('非整数抛错', () => {
    assert.throws(() => validateRuntimeLeanSlice({ maxLoadedSessions: 1.5 }), /maxLoadedSessions/)
    assert.throws(() => validateRuntimeLeanSlice({ maxEventsDiskBytes: 1_000_000.5 }), /maxEventsDiskBytes/)
  })
})
