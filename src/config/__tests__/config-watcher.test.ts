import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchConfigForHooks } from '../config-watcher.js'
import { loadConfig } from '../manager.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Spin until `cond()` is true or timeout. Real fs.watch delivery is
 *  platform-async; polling keeps the test robust without fixed sleeps. */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true
    await sleep(50)
  }
  return cond()
}

function setup(): { dir: string; cfgPath: string; base: Record<string, unknown>; prevConfigPath: string | undefined; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cfgwatch-'))
  const cfgPath = join(dir, 'config.json')
  const prevConfigPath = process.env.RIVET_CONFIG_PATH
  // Full valid Config object (schema requires search/prompt/runtime etc. at
  // top level — a partial file makes loadConfig throw, which is exactly the
  // fail-closed path we test separately).
  const base = loadConfig() as unknown as Record<string, unknown>
  writeFileSync(cfgPath, JSON.stringify(base))
  process.env.RIVET_CONFIG_PATH = cfgPath
  return {
    dir,
    cfgPath,
    base,
    prevConfigPath,
    restore: () => {
      if (prevConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
      else process.env.RIVET_CONFIG_PATH = prevConfigPath
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function withHooks(base: Record<string, unknown>, hooks: unknown): string {
  return JSON.stringify({ ...base, hooks })
}

test('watchConfigForHooks: RIVET_CONFIG_WATCH=0 时返回空 handle 不 watch', () => {
  const prev = process.env.RIVET_CONFIG_WATCH
  process.env.RIVET_CONFIG_WATCH = '0'
  try {
    const handle = watchConfigForHooks({ cwd: tmpdir(), onHooksChange: () => { assert.fail('不应回调') } })
    handle.close() // 幂等，不抛
    assert.ok(true)
  } finally {
    if (prev === undefined) delete process.env.RIVET_CONFIG_WATCH
    else process.env.RIVET_CONFIG_WATCH = prev
  }
})

test('watchConfigForHooks: hooks.disabled 变更触发回调，无变化不回调，坏 JSON fail-closed', async () => {
  const t = setup()
  const calls: Array<{ disabled?: string[] }> = []
  try {
    assert.ok(existsSync(t.cfgPath))

    const handle = watchConfigForHooks({
      cwd: t.dir,
      debounceMs: 50,
      onHooksChange: hooks => calls.push(hooks),
    })

    // 等 watcher 就绪（kqueue 注册前的写入不触发事件）
    await sleep(200)

    // 变更：写入 hooks.disabled
    writeFileSync(t.cfgPath, withHooks(t.base, { disabled: ['dream', 'kick'] }))
    assert.equal(await waitFor(() => calls.length >= 1), true, '应收到一次回调')
    assert.deepEqual(calls[0], { disabled: ['dream', 'kick'] })

    // 无变化：相同内容再写，不应回调
    const before = calls.length
    writeFileSync(t.cfgPath, withHooks(t.base, { disabled: ['dream', 'kick'] }))
    await sleep(300)
    assert.equal(calls.length, before, '无变化不应回调')

    // 坏 JSON：fail-closed 保留旧值，不回调
    writeFileSync(t.cfgPath, '{{{not json')
    await sleep(300)
    assert.equal(calls.length, before, '坏 JSON 不应回调')

    // 恢复合法且变更：回调新值
    writeFileSync(t.cfgPath, withHooks(t.base, { disabled: ['dream'] }))
    assert.equal(await waitFor(() => calls.length === before + 1), true, '恢复后应回调')
    assert.deepEqual(calls[calls.length - 1], { disabled: ['dream'] })

    handle.close()
  } finally {
    t.restore()
  }
})

test('watchConfigForHooks: 生效中的 profile 文件变更触发热更（M1 审查修复）', async () => {
  // RIVET_HOME 指向临时目录 + profiles/custom.json + RIVET_PROFILE=custom
  // （注意：'lean' 是内置 profile 不读文件，热更测试必须用文件型 profile）
  const home = mkdtempSync(join(tmpdir(), 'rivet-profilewatch-'))
  const profilesDir = join(home, 'profiles')
  mkdirSync(profilesDir, { recursive: true })
  const profileCfg = join(profilesDir, 'custom.json')
  const prevHome = process.env.RIVET_HOME
  const prevProfile = process.env.RIVET_PROFILE
  const prevConfigPath = process.env.RIVET_CONFIG_PATH
  process.env.RIVET_HOME = home
  process.env.RIVET_PROFILE = 'custom'
  // 用户 config 指向临时文件（避免读真实配置）；profile 覆盖其 hooks
  const userCfg = join(home, 'config.json')
  const base = loadConfig() as unknown as Record<string, unknown>
  delete (base as { hooks?: unknown }).hooks
  writeFileSync(userCfg, JSON.stringify(base))
  process.env.RIVET_CONFIG_PATH = userCfg
  writeFileSync(profileCfg, JSON.stringify({ hooks: { disabled: ['kick'] } }))

  const calls: Array<{ disabled?: string[] }> = []
  try {
    const handle = watchConfigForHooks({
      cwd: home,
      debounceMs: 50,
      onHooksChange: hooks => calls.push(hooks),
    })
    await sleep(200) // 等 watcher 就绪

    writeFileSync(profileCfg, JSON.stringify({ hooks: { disabled: ['kick', 'dream-distill'] } }))
    assert.equal(await waitFor(() => calls.length >= 1), true, 'profile 文件变更应触发回调')
    assert.deepEqual(calls[0], { disabled: ['kick', 'dream-distill'] })
    handle.close()
  } finally {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevProfile === undefined) delete process.env.RIVET_PROFILE
    else process.env.RIVET_PROFILE = prevProfile
    if (prevConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = prevConfigPath
    rmSync(home, { recursive: true, force: true })
  }
})
