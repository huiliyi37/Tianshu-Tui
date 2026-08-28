import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOAuthLogin } from '../login-flow.js'
import { createOAuthLoginAuth } from '../registry.js'
import { OAuthAuth } from '../oauth-auth.js'

/** 隔离 RIVET_HOME：config 与 token store 都落在临时目录。 */
function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'login-flow-'))
  const prev = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  return fn(home).finally(() => {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
  })
}

function writeConfig(home: string, providers: Record<string, unknown>): void {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ provider: { default: 'deepseek', providers } }))
}

const noop = () => {}

test('runOAuthLogin: 未知 provider → 失败并指向 /connect（默认配置含预设，此分支兜底未知名）', async () => {
  await withTempHome(async (home) => {
    writeConfig(home, {})
    const res = await runOAuthLogin('nonexistent-provider', noop)
    assert.equal(res.ok, false)
    assert.ok(res.message.includes('/connect'), res.message)
  })
})

test('runOAuthLogin: 非 OAuth 型 provider → 失败并指向 API key 通道', async () => {
  await withTempHome(async (home) => {
    writeConfig(home, {
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', models: [{ id: 'deepseek-v4-flash' }] },
    })
    const res = await runOAuthLogin('deepseek', noop)
    assert.equal(res.ok, false)
    assert.ok(res.message.includes('set-key'), res.message)
  })
})

test('runOAuthLogin: token 仍有效 → 直接成功不触发授权流', async () => {
  await withTempHome(async (home) => {
    writeConfig(home, {
      codex: { baseUrl: 'https://chatgpt.com/backend-api', auth: { type: 'oauth', provider: 'codex' }, models: [{ id: 'gpt-5.6-sol' }] },
    })
    mkdirSync(join(home, 'auth'), { recursive: true })
    writeFileSync(join(home, 'auth', 'codex.json'), JSON.stringify({
      accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600_000,
    }))
    let urlFired = false
    const res = await runOAuthLogin('codex', () => { urlFired = true })
    assert.equal(res.ok, true, res.message)
    assert.ok(res.message.includes('已登录'), res.message)
    assert.equal(urlFired, false, '已登录不应再开授权页')
  })
})

test('createOAuthLoginAuth: codex 出 OAuthAuth（带 onUserCode 钩子），未知 provider 抛错', () => {
  const auth = createOAuthLoginAuth('codex', noop)
  assert.ok(auth instanceof OAuthAuth)
  assert.throws(() => createOAuthLoginAuth('nonexistent-oauth'), /Unknown OAuth provider/)
})
