import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { buildSettingsIntentRoutes, SETTINGS_INTENT_SCHEMA, type SettingsIntentResponse } from '../settings-intent-route.js'

// POST /settings/intent 端点契约（Wave 3）——stub global fetch 四用例：
//   命中结构 / 未命中结构 / 空文本 400 / LLM 异常降级

const OPTS = { baseUrl: 'https://example.com/v1', apiKey: 'k', getModel: () => 'm', apiToken: 'token' }

function stubFetch(json: unknown, ok = true): void {
  globalThis.fetch = (async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => json,
  })) as unknown as typeof fetch
}

async function callIntent(text: unknown): Promise<{ status: number; body: SettingsIntentResponse }> {
  const routes = buildSettingsIntentRoutes(OPTS)
  const handler = routes['POST /settings/intent']!
  return handler({ text }, undefined, { authorization: 'Bearer token' }, undefined) as Promise<{ status: number; body: SettingsIntentResponse }>
}

test('LLM 命中：返回 matched+key+value', async () => {
  stubFetch({ choices: [{ message: { content: '{"matched":true,"key":"fontSize","value":"large"}' } }] })
  const r = await callIntent('把界面字调大点')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, true)
  assert.equal(r.body.key, 'fontSize')
  assert.equal(r.body.value, 'large')
})

test('LLM 未命中：返回 matched:false + message', async () => {
  stubFetch({ choices: [{ message: { content: '{"matched":false,"message":"未找到相关设置"}' } }] })
  const r = await callIntent('今天天气如何')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, false)
  assert.equal(r.body.message, '未找到相关设置')
})

test('空文本：400 空文本', async () => {
  const r = await callIntent('   ')
  assert.equal(r.status, 400)
  assert.equal(r.body.matched, false)
})

test('LLM 异常：降级 matched:false（不 5xx）', async () => {
  stubFetch({}, false) // !res.ok
  const r = await callIntent('随便说点什么')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, false)
  assert.ok(r.body.message && r.body.message.length > 0)
})

test('LLM 输出非 JSON：降级 matched:false', async () => {
  stubFetch({ choices: [{ message: { content: '抱歉我不懂' } }] })
  const r = await callIntent('随便说点什么')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, false)
})

test('LLM 幻觉 key/value：服务端 schema 白名单拒绝（防御纵深）', async () => {
  // key 不在 schema
  stubFetch({ choices: [{ message: { content: '{"matched":true,"key":"nonexistentKey","value":"large"}' } }] })
  const r1 = await callIntent('随便改改')
  assert.equal(r1.body.matched, false)
  // key 在 schema 但 value 不在该 entry 的 values 表
  stubFetch({ choices: [{ message: { content: '{"matched":true,"key":"fontSize","value":"gigantic"}' } }] })
  const r2 = await callIntent('把界面字号拉满')
  assert.equal(r2.body.matched, false)
})

test('鉴权：错误 token 401（直测鉴权分支）', async () => {
  const routes = buildSettingsIntentRoutes(OPTS) // 有 apiToken → 鉴权分支
  const handler = routes['POST /settings/intent']!
  const r = (await handler({ text: '把字调大' }, undefined, { authorization: 'Bearer wrong-token' }, undefined)) as { status: number; body: { error?: string } }
  assert.equal(r.status, 401)
  assert.equal(r.body.error, 'Unauthorized')
})

test('fail-closed：未配置 apiToken 时无 Bearer 一律 401（LLM 端点不裸奔）', async () => {
  const routes = buildSettingsIntentRoutes({ ...OPTS, apiToken: undefined })
  const handler = routes['POST /settings/intent']!
  let llmCalled = false
  globalThis.fetch = (async () => {
    llmCalled = true
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
  const r = (await handler({ text: '把字调大' }, undefined, undefined, undefined)) as { status: number }
  assert.equal(r.status, 401)
  assert.equal(llmCalled, false, '未过鉴权绝不触发 LLM 调用')
})

test('fail-closed：未配置 apiToken 时带任意 Bearer 同样 401（无后门）', async () => {
  const routes = buildSettingsIntentRoutes({ ...OPTS, apiToken: undefined })
  const handler = routes['POST /settings/intent']!
  const r = (await handler({ text: '把字调大' }, undefined, { authorization: 'Bearer whatever' }, undefined)) as { status: number }
  assert.equal(r.status, 401)
})

test('文本超长：400 拒绝（不进 LLM）', async () => {
  let llmCalled = false
  globalThis.fetch = (async () => {
    llmCalled = true
    throw new Error('should not reach LLM')
  }) as unknown as typeof fetch
  const r = await callIntent('调'.repeat(201))
  assert.equal(r.status, 400)
  assert.equal(r.body.matched, false)
  assert.equal(llmCalled, false)
})

test('LLM 输出含前缀噪音/多 JSON 对象：取第一个完整对象', async () => {
  // 前缀说明文字 + 两个 JSON 对象 → 取第一个（括号深度扫描，非 lastIndexOf 切片）
  stubFetch({
    choices: [{
      message: {
        content: '好的，我来解析。{"matched":true,"key":"fontSize","value":"large"} 这是补充说明 {"a":1}',
      },
    }],
  })
  const r = await callIntent('把字调大')
  assert.equal(r.status, 200)
  assert.equal(r.body.matched, true)
  assert.equal(r.body.key, 'fontSize')
  assert.equal(r.body.value, 'large')
})

const DESKTOP_SCHEMA_URL = new URL('../../../desktop/src/lib/settings-intent/schema.ts', import.meta.url)

test('SCHEMA 双源一致：server SETTINGS_INTENT_SCHEMA 与 desktop schema.ts key+values 对齐', { skip: !existsSync(DESKTOP_SCHEMA_URL) ? '公开仓无 desktop/（闭源面），双源校验仅在开发仓可执行' : false }, () => {
  // desktop 端 schema.ts 的 key 列表与每个 key 的 values 键集合
  const desktopSrc = readFileSync(DESKTOP_SCHEMA_URL, 'utf8')
  const keyMatches = [...desktopSrc.matchAll(/^\s+key: '([a-zA-Z]+)',/gm)].map((m) => m[1])
  const serverKeys = SETTINGS_INTENT_SCHEMA.map((s) => s.key)
  assert.deepEqual(serverKeys.sort(), [...new Set(keyMatches)].sort(), '两端 key 列表必须一致（新增设置项同步双源）')

  for (const entry of SETTINGS_INTENT_SCHEMA) {
    // desktop 端对应 entry 的 values 对象键（引号键如 '12' 与标识符键如 compact 都收；
    // 提取到 4 空格缩进的 values 闭合——避免非贪婪停在第一个 value 项）
    const block = desktopSrc.match(new RegExp(`key: '${entry.key}',[\\s\\S]*?values: \\{([\\s\\S]*?)\\n    \\},`))?.[1] ?? ''
    const desktopValues = [...block.matchAll(/^\s{4,}(?:'([^']+)'|([a-zA-Z][\w-]*)): \{/gm)].map((m) => m[1] ?? m[2])
    assert.deepEqual(
      [...entry.values].sort(),
      desktopValues.sort(),
      `${entry.key} 的 values 两端必须一致（新增档位同步双源）`,
    )
  }
})
