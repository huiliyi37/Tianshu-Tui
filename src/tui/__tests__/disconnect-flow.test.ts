import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDisconnectEntries,
  toChoiceEntries,
  buildConfirmTitle,
  buildDisconnectImpactText,
  buildPostDeleteMessage,
  buildRetargetEntries,
  toRetargetChoiceEntries,
  buildRetargetTitle,
} from '../disconnect-flow.js'
import type { ProviderConfig } from '../../config/schema.js'

function prov(over: Partial<ProviderConfig>): ProviderConfig {
  return {
    name: 'x',
    baseUrl: 'https://relay.example.com/v1',
    protocol: 'openai',
    models: [],
    ...over,
  } as ProviderConfig
}

describe('buildDisconnectEntries', () => {
  it('lists only userSaved providers, keeping insertion order', () => {
    const entries = buildDisconnectEntries({
      deepseek: prov({ name: 'deepseek' }), // 出厂预设，无 userSaved
      'relay-a': prov({ name: 'relay-a', userSaved: true }),
      'relay-b': prov({ name: 'relay-b', userSaved: true }),
    }, { defaultProvider: 'deepseek' })
    assert.deepEqual(entries.map(e => e.name), ['relay-a', 'relay-b'])
  })

  it('marks the default provider', () => {
    const entries = buildDisconnectEntries({
      'relay-a': prov({ name: 'relay-a', userSaved: true }),
    }, { defaultProvider: 'relay-a' })
    assert.equal(entries[0]?.isDefault, true)
  })

  it('groups shared credentials by keyRef, not by equal secret values', () => {
    const entries = buildDisconnectEntries({
      'relay-a': prov({ name: 'relay-a', userSaved: true, keyRef: 'key-a', apiKey: 'sk-same' }),
      'relay-b': prov({ name: 'relay-b', userSaved: true, keyRef: 'key-b', apiKey: 'sk-same' }),
      'relay-c': prov({ name: 'relay-c', userSaved: true, keyRef: 'key-a' }),
    }, { defaultProvider: 'deepseek' })
    const a = entries.find(e => e.name === 'relay-a')!
    const b = entries.find(e => e.name === 'relay-b')!
    const c = entries.find(e => e.name === 'relay-c')!
    assert.deepEqual(a.sharedKeyWith, ['relay-c'])
    assert.deepEqual(b.sharedKeyWith, [], 'same value under a different keyRef is independently managed')
    assert.deepEqual(c.sharedKeyWith, ['relay-a'], 'sharing is visible even when the secret was not materialized')
  })

  it('flags defaultModel dangling when the global default model points into the group', () => {
    const entries = buildDisconnectEntries({
      'relay-a': prov({ name: 'relay-a', userSaved: true }),
      'relay-b': prov({ name: 'relay-b', userSaved: true }),
    }, { defaultProvider: 'deepseek', defaultModelRef: 'relay-a:m1' })
    assert.equal(entries.find(e => e.name === 'relay-a')!.defaultModelDangling, true)
    assert.equal(entries.find(e => e.name === 'relay-b')!.defaultModelDangling, false)
  })
})

describe('toChoiceEntries / buildConfirmTitle', () => {
  it('renders model count, host, and hint notes', () => {
    const choices = toChoiceEntries([{
      name: 'relay-a',
      modelCount: 3,
      baseUrl: 'https://relay.example.com/v1',
      isDefault: true,
      sharedKeyWith: ['relay-b'],
      credentialImpact: { kind: 'managed-shared', keyRef: 'shared', sharedWith: ['relay-b'] },
      defaultModelDangling: true,
    }])
    assert.equal(choices[0]?.id, 'relay-a')
    assert.equal(choices[0]?.current, true)
    assert.ok(choices[0]?.description?.includes('3 个模型 · relay.example.com'))
    assert.ok(choices[0]?.description?.includes('与 relay-b 共用同一 key'))
    assert.ok(choices[0]?.description?.includes('当前默认'))
    assert.ok(choices[0]?.description?.includes('全局默认模型在此组内'))
  })

  it('strips non-standard ports into host display without crashing', () => {
    const choices = toChoiceEntries([{
      name: 'local',
      modelCount: 1,
      baseUrl: 'http://127.0.0.1:11434/v1',
      isDefault: false,
      sharedKeyWith: [],
      credentialImpact: { kind: 'none' },
      defaultModelDangling: false,
    }])
    assert.ok(choices[0]?.description?.includes('127.0.0.1:11434'))
  })

  it('confirm title carries the dangling warning only when needed', () => {
    const base = {
      name: 'relay-a',
      modelCount: 2,
      baseUrl: 'https://relay.example.com/v1',
      isDefault: false,
      sharedKeyWith: [],
      credentialImpact: { kind: 'managed-exclusive' as const, keyRef: 'relay-a' },
    }
    const plain = buildConfirmTitle({ ...base, defaultModelDangling: false })
    const dangling = buildConfirmTitle({ ...base, defaultModelDangling: true })
    assert.ok(plain.includes('断开「relay-a」'))
    assert.ok(plain.includes('2 个模型'))
    assert.ok(!plain.includes('一并清除'))
    assert.ok(dangling.includes('一并清除'))
  })
})

describe('credential impact copy', () => {
  it('describes exclusive, shared, environment, legacy-inline, and keyless credentials accurately', () => {
    const entries = buildDisconnectEntries({
      exclusive: prov({ name: 'exclusive', userSaved: true, keyRef: 'exclusive' }),
      sharedA: prov({ name: 'sharedA', userSaved: true, keyRef: 'shared' }),
      sharedB: prov({ name: 'sharedB', userSaved: true, keyRef: 'shared' }),
      env: prov({ name: 'env', userSaved: true, apiKeyEnv: 'RELAY_API_KEY' }),
      legacy: prov({ name: 'legacy', userSaved: true, apiKey: 'sk-legacy' }),
      local: prov({ name: 'local', userSaved: true }),
    }, { defaultProvider: 'deepseek' })
    const byName = (name: string) => entries.find(e => e.name === name)!

    assert.match(buildDisconnectImpactText(byName('exclusive')), /删除.*secrets\.json.*API key/)
    assert.match(buildDisconnectImpactText(byName('sharedA')), /sharedB.*保留/)
    assert.match(buildDisconnectImpactText(byName('env')), /RELAY_API_KEY.*不会修改/)
    assert.match(buildDisconnectImpactText(byName('legacy')), /旧鉴权信息.*配置.*删除/)
    assert.doesNotMatch(buildDisconnectImpactText(byName('local')), /API key|secrets\.json|环境变量/)
  })

  it('uses the same credential impact in the confirm title', () => {
    const entry = buildDisconnectEntries({
      local: prov({ name: 'local', userSaved: true, models: [{ id: 'm' } as any] }),
    }, { defaultProvider: 'deepseek' })[0]!
    assert.doesNotMatch(buildConfirmTitle(entry), /API key|secrets\.json/)
    assert.match(buildConfirmTitle(entry), /只删除 provider 条目和 1 个模型/)
  })
})

describe('post-delete runtime feedback', () => {
  const removal = { modelCount: 2, secretNote: '，API key 已清除' }

  it('reports complete success when no runtime migration is needed', () => {
    const result = buildPostDeleteMessage('relay-a', removal, { needed: false, switched: false })
    assert.equal(result.isError, false)
    assert.match(result.text, /已断开 relay-a.*API key 已清除/)
  })

  it('reports complete success after a runtime switch', () => {
    const result = buildPostDeleteMessage('relay-a', removal, { needed: true, switched: true, targetModel: 'fallback' })
    assert.equal(result.isError, false)
    assert.match(result.text, /当前会话已切换到 fallback/)
  })

  it('reports partial success when the default provider has no model', () => {
    const result = buildPostDeleteMessage('relay-a', removal, {
      needed: true,
      switched: false,
      error: '默认 provider 没有可用模型',
    })
    assert.equal(result.isError, true)
    assert.match(result.text, /已断开 relay-a.*但当前会话切换失败.*没有可用模型/)
  })

  it('surfaces switchAgentRuntime errors instead of claiming full success', () => {
    const result = buildPostDeleteMessage('relay-a', removal, {
      needed: true,
      switched: false,
      error: 'API key not set for deepseek',
    })
    assert.equal(result.isError, true)
    assert.match(result.text, /API key not set for deepseek/)
  })
})

describe('retarget builders（默认 provider 改设新默认）', () => {
  it('excludes the current default, non-userSaved presets, and model-less providers', () => {
    const entries = buildRetargetEntries({
      'relay-a': prov({ name: 'relay-a', userSaved: true, models: [{ id: 'm' } as any] }),
      deepseek: prov({ name: 'deepseek', models: [{ id: 'd' } as any] }), // 出厂预设无 key → 排除
      'empty-one': prov({ name: 'empty-one', userSaved: true }), // 无模型 → 排除
      'relay-b': prov({ name: 'relay-b', userSaved: true, models: [{ id: 'm2' } as any] }),
    }, 'relay-b')
    assert.deepEqual(entries.map(e => e.name), ['relay-a'])
  })

  it('renders choice entries with model count and host', () => {
    const choices = toRetargetChoiceEntries([{ name: 'relay-a', modelCount: 2, baseUrl: 'https://relay.example.com/v1' }])
    assert.equal(choices[0]?.id, 'relay-a')
    assert.ok(choices[0]?.description?.includes('2 个模型 · relay.example.com'))
  })

  it('retarget title names the locked default', () => {
    const title = buildRetargetTitle('relay-b')
    assert.ok(title.includes('「relay-b」是当前默认'))
    assert.ok(title.includes('请先选择新的默认 provider'))
  })
})
