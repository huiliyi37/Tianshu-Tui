/**
 * `/config` 面板的 I/O 边界：把配置读成 draft，把脏块写回对应 setter。
 *
 * 面板本体（settings-model / settings-flow / format/settings）保持纯函数，
 * 所有 `loadConfig` / `set*Config` 调用只在这里发生。
 *
 * 写入粒度 = 块。每个块对应恰好一个 setter，只写真正改过的块 —— 面板不该
 * 因为用户改了代理地址就顺手重写 workers 路由（覆盖别的会话刚改的值）。
 */

import {
  getCheckpointConfig,
  getDefaultDomainConfig,
  getDefaultModelConfig,
  getFetchConfig,
  getMirrorConfig,
  getNetworkConfig,
  getRoutingConfig,
  getSearchConfig,
  getToolPresetConfig,
  getVisionAutoBridge,
  getVisionModelConfig,
  loadConfig,
  setApprovalMode,
  setCheckpointConfig,
  setDefaultDomainConfig,
  setDefaultModelConfig,
  setFetchConfig,
  setModelSupportsVision,
  setMirrorConfig,
  setNetworkConfig,
  setRoutingConfig,
  setSearchConfig,
  setToolPresetConfig,
  setVisionAutoBridge,
  setVisionModelConfig,
} from '../config/manager.js'
import { buildDomainPickerEntries } from '../agent/domain-picker-entries.js'
import type { SettingsBlockId, SettingsDraft, SettingsEnv } from './settings-model.js'
import { splitModelRef } from './settings-model.js'
import type { SettingsSaveResult } from './settings-flow.js'

/** Runtime side-effects the panel cannot do by itself. */
export interface SettingsHooks {
  /**
   * Approval mode is the one field that must also land on the *running* session,
   * so it is routed through the TUI's existing approval persistence instead of
   * `setApprovalMode` alone. Returns false when it could not be applied.
   */
  onApprovalChange?: (mode: string) => boolean
}

/** Read the current effective config into a panel draft. */
export function loadSettingsDraft(): SettingsDraft {
  const routing = getRoutingConfig()
  const cfg = loadConfig()
  const mirrors = getMirrorConfig()
  const network = getNetworkConfig()
  const search = getSearchConfig()
  const fetchCfg = getFetchConfig()
  const vision = getVisionModelConfig()
  return {
    workers: routing.workers,
    review: routing.review,
    vision: vision
      ? {
          provider: vision.provider,
          model: vision.model,
          prompt: vision.prompt,
          maxTokens: vision.maxTokens,
          fallback: vision.fallback,
        }
      : null,
    visionAutoBridge: getVisionAutoBridge(),
    // modelVision 只存用户在面板里的覆盖；初始为空，display 时 fallback 到模型卡的 supportsVision。
    modelVision: {},
    basics: {
      toolPreset: getToolPresetConfig().preset ?? 'frontend',
      approval: cfg.agent.approval,
      checkpointEveryTurns: getCheckpointConfig().checkpointEveryTurns,
      defaultDomain: getDefaultDomainConfig().defaultDomain,
      defaultModel: getDefaultModelConfig().defaultModel ?? '',
    },
    net: {
      mirrorsEnabled: mirrors.enabled,
      mirrorsPreset: mirrors.preset,
      proxy: network.proxy ?? '',
      noProxy: network.noProxy ?? '',
      searchBackends: (search.backends ?? []).join(', '),
      jinaBaseUrl: fetchCfg.jinaBaseUrl ?? '',
    },
  }
}

/**
 * Enumerate model / domain choices for the panel.
 *
 * `supportsVision` comes straight from the stored model cards — which is why the
 * preset backfill in `loadConfig` matters here: without it, older configs would
 * present an empty vision candidate list even though the model does support it.
 */
export function loadSettingsEnv(): SettingsEnv {
  const cfg = loadConfig()
  const models: SettingsEnv['models'] = []
  for (const [provider, p] of Object.entries(cfg.provider.providers)) {
    for (const m of p.models) {
      models.push({ provider, id: m.id, alias: m.alias, supportsVision: m.supportsVision === true })
    }
  }
  const domains = buildDomainPickerEntries(undefined).map(d => ({ key: d.key, name: d.name }))
  return { models, domains }
}

function parseBackends(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
}

/**
 * Write the dirty blocks. Each block is written independently: one failing
 * setter reports its own error and the rest still land, so a bad proxy string
 * cannot silently swallow a valid routing change.
 */
export function saveSettings(
  request: { draft: SettingsDraft; blocks: SettingsBlockId[] },
  hooks?: SettingsHooks,
): SettingsSaveResult {
  const { draft, blocks } = request
  const saved: SettingsBlockId[] = []
  const errors: string[] = []

  const attempt = (block: SettingsBlockId, write: () => void): void => {
    try {
      write()
      saved.push(block)
    } catch (err) {
      errors.push(`${block}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const block of blocks) {
    switch (block) {
      case 'workers':
        attempt(block, () => setRoutingConfig({ workers: draft.workers }))
        break
      case 'review':
        attempt(block, () => setRoutingConfig({ review: draft.review }))
        break
      case 'vision':
        attempt(block, () => setVisionModelConfig(draft.vision === null ? null : {
          provider: draft.vision.provider,
          model: draft.vision.model,
          prompt: draft.vision.prompt,
          maxTokens: draft.vision.maxTokens,
          // 显式发 null 清除、发对象设置——省略会被 setter 当作"保留现有"，那样面板里
          // 清掉备用桥就无效了。
          fallback: draft.vision.fallback ?? null,
        }))
        break
      case 'visionAuto':
        attempt(block, () => setVisionAutoBridge(draft.visionAutoBridge))
        break
      case 'modelVision': {
        // draft.modelVision 存的是「覆盖值」——只写与磁盘现状不同的模型，避免无谓写盘。
        // setModelSupportsVision 内部做了幂等（相同值 no-op）。
        attempt(block, () => {
          const cfg = loadConfig()
          for (const [ref, value] of Object.entries(draft.modelVision)) {
            const parts = splitModelRef(ref)
            if (!parts) continue
            const provider = cfg.provider.providers[parts.provider]
            const model = provider?.models.find(m => m.id === parts.model || m.alias === parts.model)
            // 只在覆盖值与磁盘现状不同时写入
            if (model && (model.supportsVision === true) !== value) {
              setModelSupportsVision(parts.provider, model.id, value)
            }
          }
        })
        break
      }
      case 'toolPreset':
        attempt(block, () => setToolPresetConfig({ preset: draft.basics.toolPreset }))
        break
      case 'approval':
        attempt(block, () => {
          // 落盘 + 运行时同步。hook 缺失（非交互路径）时只落盘，并如实报告。
          const applied = hooks?.onApprovalChange?.(draft.basics.approval)
          if (applied === undefined) setApprovalMode(draft.basics.approval)
          else if (!applied) throw new Error('运行时未接受该审批模式')
        })
        break
      case 'checkpoint':
        attempt(block, () => setCheckpointConfig({ checkpointEveryTurns: draft.basics.checkpointEveryTurns }))
        break
      case 'defaultDomain':
        attempt(block, () => setDefaultDomainConfig({ defaultDomain: draft.basics.defaultDomain }))
        break
      case 'defaultModel':
        attempt(block, () => setDefaultModelConfig({ defaultModel: draft.basics.defaultModel }))
        break
      case 'mirrors':
        attempt(block, () => setMirrorConfig({ enabled: draft.net.mirrorsEnabled, preset: draft.net.mirrorsPreset }))
        break
      case 'network':
        attempt(block, () => setNetworkConfig({ proxy: draft.net.proxy, noProxy: draft.net.noProxy }))
        // jinaBaseUrl 与 proxy/noProxy 同属 network 块——一起写。空串删键回落默认 r.jina.ai。
        attempt(block, () => setFetchConfig({ jinaBaseUrl: draft.net.jinaBaseUrl }))
        break
      case 'search':
        attempt(block, () => {
          const parsed = parseBackends(draft.net.searchBackends)
          // 清空 = 删键回落默认链（bing/DDG），而不是写一个空数组让 web_search 无后端可用。
          setSearchConfig({ backends: parsed.length > 0 ? parsed : '' })
        })
        break
    }
  }

  // 重新读盘作为新基线：setter 会规范化（schema 默认值、空串删键），
  // 直接把内存 draft 当基线会让面板显示与磁盘内容悄悄分叉。
  return { saved, errors, persisted: saved.length > 0 ? loadSettingsDraft() : undefined }
}
