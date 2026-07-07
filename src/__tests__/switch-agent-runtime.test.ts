/**
 * switchAgentRuntime — 模型切换查找/错误路径测试。
 *
 * 仅覆盖 createAgentRuntime 之前可确定性断言的分支（未找到模型 / 缺少 API key），
 * 成功路径会重建完整 AgentLoop（重型依赖），由真终端手验覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { switchAgentRuntime } from '../bootstrap.js'
import type { BootstrapContext } from '../bootstrap.js'

function makeCtx(providers: Record<string, unknown>, currentName = 'p1'): BootstrapContext {
  return {
    config: { provider: { providers } },
    provider: { name: currentName },
  } as unknown as BootstrapContext
}

test('未知模型返回 not found，不重建 agent', () => {
  const ctx = makeCtx({
    p1: { name: 'p1', apiKey: 'k', models: [{ id: 'm1', alias: 'mm' }] },
  })
  const res = switchAgentRuntime(ctx, 'does-not-exist')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /not found/i)
})

test('找到模型但缺少 API key → 返回 API key 错误（非 oauth）', () => {
  // 切换目标在另一个 provider 上，无 apiKey / apiKeyEnv 未设
  delete process.env.__RIVET_TEST_MISSING_KEY__
  const ctx = makeCtx({
    p1: { name: 'p1', apiKey: 'k', models: [{ id: 'cur', alias: 'cur' }] },
    p2: { name: 'p2', apiKeyEnv: '__RIVET_TEST_MISSING_KEY__', models: [{ id: 'target', alias: 't' }] },
  })
  const res = switchAgentRuntime(ctx, 'target')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /API key/i)
})

test('按 alias 也能匹配到模型（未找到分支不误报）', () => {
  // alias 命中但缺 key → 至少不应报 "not found"（证明 alias 查找生效）
  const ctx = makeCtx({
    p1: { name: 'p1', apiKey: 'k', models: [{ id: 'cur', alias: 'cur' }] },
    p2: { name: 'p2', apiKeyEnv: '__RIVET_TEST_MISSING_KEY2__', models: [{ id: 'real-id', alias: 'nice-alias' }] },
  })
  const res = switchAgentRuntime(ctx, 'nice-alias')
  assert.equal(res.ok, false)
  assert.doesNotMatch(res.error ?? '', /not found/i)
  assert.match(res.error ?? '', /API key/i)
})
