import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProfileName, resolveProfileOverlay, loadProfileOverlay, LEAN_PROFILE, profilePath } from '../profile.js'
import { loadConfig } from '../manager.js'

function withEnv<K extends string>(key: K, value: string | undefined, run: () => void): void {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    run()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

test('resolveProfileName: flag 优先于 env，env 单独生效，无则 undefined', () => {
  withEnv('RIVET_PROFILE', 'lean', () => {
    assert.equal(resolveProfileName(undefined), 'lean')
    assert.equal(resolveProfileName('custom'), 'custom', 'flag 优先')
  })
  withEnv('RIVET_PROFILE', undefined, () => {
    assert.equal(resolveProfileName(undefined), undefined)
    assert.equal(resolveProfileName(' '), undefined, '空白 flag 忽略')
  })
})

test('resolveProfileOverlay: 内置 lean/default 与用户文件，坏文件 fail-closed 空覆盖', () => {
  // 内置
  assert.deepEqual(resolveProfileOverlay('lean'), LEAN_PROFILE)
  assert.deepEqual(resolveProfileOverlay('default'), {})
  assert.deepEqual(resolveProfileOverlay(undefined), {})

  // 用户文件（临时 RIVET_HOME）
  const home = mkdtempSync(join(tmpdir(), 'rivet-profile-'))
  const prevHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  try {
    mkdirSync(join(home, 'profiles'), { recursive: true })
    const customPath = profilePath('custom')
    writeFileSync(customPath, JSON.stringify({ hooks: { disabled: ['kick'] } }))
    assert.deepEqual(resolveProfileOverlay('custom'), { hooks: { disabled: ['kick'] } })
    assert.deepEqual(loadProfileOverlay('custom'), { hooks: { disabled: ['kick'] } })

    // 缺失 → 空
    assert.deepEqual(resolveProfileOverlay('missing'), {})

    // 坏 JSON → 空（fail-closed 不生效）
    writeFileSync(profilePath('broken'), '{{{')
    assert.deepEqual(resolveProfileOverlay('broken'), {})
  } finally {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadConfig profile 层：RIVET_PROFILE=lean 时 hooks.disabled 生效且可被 sessionOverlay 覆盖', () => {
  withEnv('RIVET_PROFILE', 'lean', () => {
    const base = loadConfig()
    assert.deepEqual(base.hooks.disabled, ['dream-distill', 'skill-distill', 'anchor-break-scout'])

    // sessionOverlay（Layer 4）覆盖 profile（Layer 3.5）
    const overlaid = loadConfig({ sessionOverlay: { hooks: { disabled: ['kick'] } } })
    assert.deepEqual(overlaid.hooks.disabled, ['kick'])
  })

  // 无 profile → hooks 空
  withEnv('RIVET_PROFILE', undefined, () => {
    assert.deepEqual(loadConfig().hooks, {})
  })
})
