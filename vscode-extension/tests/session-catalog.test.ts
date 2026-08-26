import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionCatalog, catalogSelection } from '../src/sidecar/session-catalog.ts'

const providers = [
  {
    name: 'deepseek',
    label: 'DeepSeek',
    isDefault: true,
    keyStatus: { source: 'env' as const, ref: 'DEEPSEEK_API_KEY' },
    models: [{ id: 'deepseek-v4-pro', alias: 'v4-pro' }, { id: 'deepseek-v4-flash', alias: 'v4-flash' }],
    isPreset: true,
  },
  {
    name: 'glm',
    label: 'GLM',
    isDefault: false,
    keyStatus: { source: 'none' as const, ref: '' },
    models: [{ id: 'glm-4', alias: 'GLM-4' }],
    isPreset: true,
  },
]

test('buildSessionCatalog: 只用已配 key 的 provider，选项 id 是 provider:model', () => {
  const { models } = buildSessionCatalog(providers, 'deepseek:deepseek-v4-flash', 'qiming', [
    { id: 'qiming', name: '启明', motto: '先看再写' },
  ])
  assert.deepEqual(models.map((m) => m.id), ['deepseek:deepseek-v4-pro', 'deepseek:deepseek-v4-flash'])
  assert.equal(models.find((m) => m.current)?.id, 'deepseek:deepseek-v4-flash')
})

test('buildSessionCatalog: 无默认模型时标第一条；星域含自动', () => {
  const { models, domains } = buildSessionCatalog(providers, null, 'auto', [
    { id: 'tianshu', name: '天枢', motto: '稳' },
  ])
  assert.equal(models[0]?.current, true)
  assert.equal(catalogSelection(models, domains).domain, 'auto')
  assert.ok(domains.some((d) => d.key === 'auto' && d.current))
})
