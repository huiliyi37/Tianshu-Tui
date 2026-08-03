/**
 * `/config` 落盘测试 —— 关键门禁：面板说「已保存」时，磁盘上**只有**用户改过的
 * 块变了。写错块的杀伤面是双向的：既悄悄回退别处的配置，也让用户以为改的那项
 * 生效了。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, setRoutingConfig } from '../../config/manager.js'
import { loadSettingsDraft, loadSettingsEnv, saveSettings } from '../settings-persist.js'
import { SettingsFlow } from '../settings-flow.js'
import { dirtyBlocks, type SettingsDraft } from '../settings-model.js'

describe('settings persist', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-settings-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the effective config into a draft', () => {
    const draft = loadSettingsDraft()
    assert.equal(typeof draft.basics.approval, 'string')
    assert.equal(draft.vision, null)
    assert.ok(Object.keys(draft.workers.profiles).length > 0, 'worker 档位应来自默认配置')
    assert.ok(draft.net.searchBackends.includes('bing'))
  })

  it('只写脏块——其余块的磁盘内容逐字不动', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = {
      ...before,
      basics: { ...before.basics, toolPreset: 'minimal', checkpointEveryTurns: 7 },
    }
    const blocks = dirtyBlocks(before, draft)
    assert.deepEqual(blocks.sort(), ['checkpoint', 'toolPreset'])

    const result = saveSettings({ draft, blocks })
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.saved.sort(), ['checkpoint', 'toolPreset'])

    const after = loadSettingsDraft()
    assert.equal(after.basics.toolPreset, 'minimal')
    assert.equal(after.basics.checkpointEveryTurns, 7)
    // 未列入 blocks 的块必须原样
    assert.deepEqual(after.workers, before.workers)
    assert.deepEqual(after.review, before.review)
    assert.equal(after.vision, null)
    assert.deepEqual(after.net, before.net)
    assert.equal(after.basics.defaultDomain, before.basics.defaultDomain)
  })

  it('改子代理路由不会顺手重写审查块', () => {
    // 先在磁盘上留下一个 review 覆盖，模拟别处已有配置。
    setRoutingConfig({ review: { profiles: { reviewer: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, skipAuto: true, mechanicalFastPath: true } })
    const before = loadSettingsDraft()
    const draft: SettingsDraft = {
      ...before,
      workers: { ...before.workers, patcherTier: 'strong' },
    }
    const blocks = dirtyBlocks(before, draft)
    assert.deepEqual(blocks, ['workers'])

    saveSettings({ draft, blocks })
    const after = loadSettingsDraft()
    assert.equal(after.workers.patcherTier, 'strong')
    assert.deepEqual(after.review.profiles, { reviewer: { provider: 'deepseek', model: 'deepseek-v4-pro' } })
  })

  it('写识图桥并能再清除', () => {
    const before = loadSettingsDraft()
    const withVision: SettingsDraft = {
      ...before,
      vision: { provider: 'minimax', model: 'MiniMax-M3', maxTokens: 2048 },
    }
    saveSettings({ draft: withVision, blocks: dirtyBlocks(before, withVision) })
    const saved = loadSettingsDraft()
    assert.deepEqual(saved.vision, {
      provider: 'minimax', model: 'MiniMax-M3', prompt: undefined, maxTokens: 2048, fallback: undefined,
    })

    const cleared: SettingsDraft = { ...saved, vision: null }
    saveSettings({ draft: cleared, blocks: dirtyBlocks(saved, cleared) })
    assert.equal(loadSettingsDraft().vision, null)
  })

  // 备用识图桥必须在 draft 里往返：面板不显示的字段一保存就消失，等于两个界面
  // （桌面端 / 面板 / 手写配置）互相抹配置。
  it('备用识图模型能存能读能清', () => {
    const before = loadSettingsDraft()
    const withFallback: SettingsDraft = {
      ...before,
      vision: {
        provider: 'minimax', model: 'MiniMax-M3', maxTokens: 1024,
        fallback: { provider: 'glm', model: 'glm-5.2' },
      },
    }
    saveSettings({ draft: withFallback, blocks: dirtyBlocks(before, withFallback) })
    const saved = loadSettingsDraft()
    assert.deepEqual(saved.vision?.fallback, { provider: 'glm', model: 'glm-5.2' })

    // 只改 maxTokens 不该带走备用桥。
    const bumped: SettingsDraft = { ...saved, vision: { ...saved.vision!, maxTokens: 512 } }
    saveSettings({ draft: bumped, blocks: dirtyBlocks(saved, bumped) })
    assert.deepEqual(loadSettingsDraft().vision?.fallback, { provider: 'glm', model: 'glm-5.2' })

    // 面板里清掉备用桥要真的清掉（省略即保留的语义下必须显式发 null）。
    const dropped: SettingsDraft = { ...bumped, vision: { ...bumped.vision!, fallback: undefined } }
    saveSettings({ draft: dropped, blocks: dirtyBlocks(bumped, dropped) })
    assert.equal(loadSettingsDraft().vision?.fallback, undefined)
  })

  it('搜索后端清空 = 回落默认链，而不是写一个空数组', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = { ...before, net: { ...before.net, searchBackends: '' } }
    saveSettings({ draft, blocks: dirtyBlocks(before, draft) })
    const backends = loadConfig().search.backends
    assert.ok(backends.length > 0, '空输入不应留下无后端可用的 web_search')
  })

  it('代理地址留空会删键（回落环境变量），而不是写空串', () => {
    const before = loadSettingsDraft()
    const withProxy: SettingsDraft = { ...before, net: { ...before.net, proxy: 'http://127.0.0.1:7890' } }
    saveSettings({ draft: withProxy, blocks: dirtyBlocks(before, withProxy) })
    assert.equal(loadConfig().network.proxy, 'http://127.0.0.1:7890')

    const saved = loadSettingsDraft()
    const cleared: SettingsDraft = { ...saved, net: { ...saved.net, proxy: '' } }
    saveSettings({ draft: cleared, blocks: dirtyBlocks(saved, cleared) })
    assert.equal(loadConfig().network.proxy, undefined)
  })

  it('单个 setter 失败只报自己那块，其他块照写', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = {
      ...before,
      basics: { ...before.basics, toolPreset: 'full', defaultModel: 'nonexistent-provider:ghost-model' },
    }
    const result = saveSettings({ draft, blocks: dirtyBlocks(before, draft) })
    assert.deepEqual(result.saved, ['toolPreset'])
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0]!, /defaultModel/)
    assert.equal(loadSettingsDraft().basics.toolPreset, 'full')
  })

  it('审批模式经运行时 hook 落地；hook 拒绝时如实报错', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = { ...before, basics: { ...before.basics, approval: 'auto-accept' } }
    const seen: string[] = []
    const ok = saveSettings({ draft, blocks: ['approval'] }, {
      onApprovalChange: mode => { seen.push(mode); return true },
    })
    assert.deepEqual(seen, ['auto-accept'])
    assert.deepEqual(ok.saved, ['approval'])

    const rejected = saveSettings({ draft, blocks: ['approval'] }, { onApprovalChange: () => false })
    assert.deepEqual(rejected.saved, [])
    assert.match(rejected.errors[0]!, /approval/)
  })

  it('无 hook 时审批模式仍直接落盘', () => {
    const before = loadSettingsDraft()
    const draft: SettingsDraft = { ...before, basics: { ...before.basics, approval: 'manual' } }
    saveSettings({ draft, blocks: ['approval'] })
    assert.equal(loadSettingsDraft().basics.approval, 'manual')
  })

  it('保存后回读的基线与磁盘一致（面板不与磁盘分叉）', () => {
    const flow = new SettingsFlow(loadSettingsDraft(), loadSettingsEnv())
    // 走一遍面板：基础 → 工具档位 → 选下一档
    flow.focusCategories()
    for (let i = 0; i < 10; i++) {
      if (flow.view().categories[flow.view().categoryIndex]?.id === 'basics') break
      flow.moveDown()
    }
    flow.focusFields()
    for (let i = 0; i < 20; i++) {
      if (flow.view().fields[flow.view().fieldIndex]?.id === 'tools.preset') break
      flow.moveDown()
    }
    flow.activate()
    flow.moveDown()
    flow.activate()

    const request = flow.saveRequest()
    assert.deepEqual(request.blocks, ['toolPreset'])
    flow.commitSaved(saveSettings(request))

    assert.deepEqual(flow.dirty(), [], '保存后不应还有脏块')
    assert.match(flow.view().status ?? '', /已保存/)
    // 面板从默认 frontend 下移一档选到 full，保存后回读应为 full（与磁盘一致）。
    assert.equal(loadSettingsDraft().basics.toolPreset, 'full')
  })

  it('候选模型来自实际配置，识图候选按 supportsVision 过滤', () => {
    const env = loadSettingsEnv()
    assert.ok(env.models.length > 0)
    assert.ok(env.domains.some(d => d.key === 'auto'))
    for (const m of env.models) assert.equal(typeof m.supportsVision, 'boolean')
  })
})
