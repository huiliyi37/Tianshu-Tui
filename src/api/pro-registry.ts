/**
 * Pro 扩展点（公开仓唯一可见的 pro 相关代码）。
 *
 * 职责：① 定义注册表接口；② 启动时变量路径动态 import `./../pro/index.js`
 * （变量传递绕开 tsc 静态存在性检查），失败静默降级；③ 提供「静态表 +
 * 注册表」合并视图查询（resolvePreset / allPresetKeys），供配置链五消费点
 * 统一改查合并视图。开源构建无 pro 模块时注册表恒空，合并 = 恒等，行为不变。
 *
 * 闭源边界：本文件不含任何算法与 preset 定义（那些在 src/pro/，由
 * sync-to-public.sh:39 的 --exclude 'pro/' 排除，不进公开仓）。
 */

import { PROVIDER_PRESETS, providerPresetKeys } from '../config/provider-presets.js'
import type { ProviderPreset } from '../config/provider-presets.js'
import type { ProClientFactory } from './pro-types.js'
import type { OaiMessage } from './oai-types.js'

/** wire 变换的会话级上下文（2026-08-07 spark v2 T1）。
 *  截断 N 等参数必须随会话冻结（meta 持久化，resume 读回）——进程级 env 常量
 *  会在 env 漂移（GUI 启动的 sidecar 不继承 shell env / 未来改默认值）后
 *  让历史消息的 wire 字节漂移，打穿前缀缓存。ctx 缺席时变换方可退回自身默认
 *  （env），即"会话首启"语义。多会话并发（sidecar）下 ctx 必须经 per-session
 *  配置逐层传入，绝不能落在模块级可变状态里。 */
export interface WireTransformContext {
  /** reasoning 尾部截断的会话固化 N（按模型档位区分）。 */
  truncateN?: { flash: number; pro: number }
}

/** wire 层消息变换（spec 3c 截断落点）：在发送前对单条 assistant 消息做
 *  copy-on-write 变换（如 reasoning 尾部截断）。开源版注册表恒空 → 不变换。 */
export type WireTransform = (m: OaiMessage, model: string | undefined, ctx?: WireTransformContext) => OaiMessage

/** 推理锚点提取（spec 3c 动作 B）：对一段完整 reasoning 返回「被 wire 截断
 *  丢失的前段中已排除的路径」锚点句。无截断/无命中返回 []。
 *  开源版注册表恒空 → 不提取、appendix 零渲染零字节差异。
 *  ⚠ 必须与 WireTransform 收同一 ctx——两者靠同 tokenizer 同 N 保证
 *  「提取域 = 截断丢失域」精确互补，N 失配即重复注入或漏补偿。 */
export type ReasoningAnchorExtractor = (reasoning: string, model: string | undefined, ctx?: WireTransformContext) => string[]

/** pro 注册的额外 preset（key 不在 ProviderPresetKey 联合类型内） */
export interface ProPresetEntry {
  key: string
  label: string
  description?: string
  /** 独立 API key 环境变量名（与 deepseek 节点分离，可各配各的） */
  apiKeyEnv?: string
  defaultModelId: string
  /** 完整 provider 配置（baseUrl / models / capabilities / tier 等） */
  provider: import('../config/schema.js').ProviderConfig
}

export interface ProRegistry {
  registerPreset(entry: ProPresetEntry): void
  getPreset(key: string): ProPresetEntry | undefined
  keys(): string[]
  /** pro 模块可注册自定义 client 工厂（协议非 OpenAI 兼容时）；缺省走原路径 */
  registerClientFactory(providerName: string, factory: ProClientFactory): void
  getClientFactory(providerName: string): ProClientFactory | undefined
  /** wire 层消息变换（截断等）：按 providerName 注册，openai-client 发送前调用 */
  registerWireTransform(providerName: string, fn: WireTransform): void
  getWireTransform(providerName: string): WireTransform | undefined
  /** 推理锚点提取：按 providerName 注册，agent 落库时调用（spec 3c 动作 B） */
  registerAnchorExtractor(providerName: string, fn: ReasoningAnchorExtractor): void
  getAnchorExtractor(providerName: string): ReasoningAnchorExtractor | undefined
  /** wire 上下文默认值：会话首启时开源侧调用一次取当前默认（如 env 解析的
   *  截断 N），冻结进会话 meta；此后恒以 meta 值经 ctx 回传。闭源边界：env
   *  变量名与解析逻辑留在 pro 模块内，开源侧只见结构化默认值。 */
  registerWireContextDefaults(providerName: string, fn: () => WireTransformContext): void
  getWireContextDefaults(providerName: string): (() => WireTransformContext) | undefined
}

function createRegistry(): ProRegistry {
  const presets = new Map<string, ProPresetEntry>()
  const clientFactories = new Map<string, ProClientFactory>()
  const wireTransforms = new Map<string, WireTransform>()
  const anchorExtractors = new Map<string, ReasoningAnchorExtractor>()
  const wireContextDefaults = new Map<string, () => WireTransformContext>()
  return {
    registerPreset(entry) {
      presets.set(entry.key, entry)
    },
    getPreset(key) {
      return presets.get(key)
    },
    keys() {
      return [...presets.keys()]
    },
    registerClientFactory(providerName, factory) {
      clientFactories.set(providerName, factory)
    },
    getClientFactory(providerName) {
      return clientFactories.get(providerName)
    },
    registerWireTransform(providerName, fn) {
      wireTransforms.set(providerName, fn)
    },
    getWireTransform(providerName) {
      return wireTransforms.get(providerName)
    },
    registerAnchorExtractor(providerName, fn) {
      anchorExtractors.set(providerName, fn)
    },
    getAnchorExtractor(providerName) {
      return anchorExtractors.get(providerName)
    },
    registerWireContextDefaults(providerName, fn) {
      wireContextDefaults.set(providerName, fn)
    },
    getWireContextDefaults(providerName) {
      return wireContextDefaults.get(providerName)
    },
  }
}

export const proRegistry: ProRegistry = createRegistry()

let proLoadAttempted = false

/**
 * 启动时加载闭源模块。失败静默降级且不置位——下次调用可重试
 * （首载失败多为打包/路径问题，进程内应有机会恢复）。
 *
 * 候选路径覆盖两种运行形态：
 * - src 形态（tsx/dev）：import.meta.url 指向 src/api/pro-registry.ts → ../pro/index.js
 * - dist 形态（bundle）：import.meta.url 指向 dist/main.js → ./pro/index.js
 *   （tsup entry 含 src/pro/index.ts，产物为 dist/pro/index.js）
 */
export async function loadProModule(): Promise<void> {
  if (proLoadAttempted) return
  const candidates = [
    new URL('../pro/index.js', import.meta.url).href, // src 形态
    new URL('./pro/index.js', import.meta.url).href, // dist 形态
  ]
  for (const path of candidates) {
    try {
      // 变量传递：esbuild 不做静态内联，保留运行时 import
      const mod = await import(path)
      mod?.register?.(proRegistry)
      proLoadAttempted = true // 成功才置位；失败允许下次重试
      return
    } catch {
      // 尝试下一个候选；全部失败则静默降级（开源构建无 pro 模块）
    }
  }
}

/** 静态表 + 注册表合并解析：先静态（类型安全），后注册表（运行时） */
export function resolvePreset(name: string): ProPresetEntry | { static: ProviderPreset } | undefined {
  if ((providerPresetKeys as string[]).includes(name)) {
    return { static: PROVIDER_PRESETS[name as keyof typeof PROVIDER_PRESETS] }
  }
  return proRegistry.getPreset(name)
}

/** 合并视图 label 提取（config-routes 已配置节点展示用） */
export function resolvePresetLabel(name: string): string | undefined {
  const r = resolvePreset(name)
  if (!r) return undefined
  return 'static' in r ? r.static.label : r.label
}

/** 合并视图 baseUrl 提取（test-key 回退链用） */
export function resolvePresetBaseUrl(name: string): string | undefined {
  const r = resolvePreset(name)
  if (!r) return undefined
  return 'static' in r ? r.static.provider.baseUrl : r.provider.baseUrl
}

/** 合并视图 clone provider 配置（setupProvider 写端用；静态优先） */
export function cloneResolvedPreset(name: string): import('../config/schema.js').ProviderConfig | undefined {
  const r = resolvePreset(name)
  if (!r) return undefined
  return structuredClone('static' in r ? r.static.provider : r.provider)
}

/** 全部 preset key（静态 + 注册表，注册表覆盖同名静态键）。
 *  排序：pro 注册的 preset 紧跟 deepseek 之后（桌面 Settings 紧邻展示），
 *  其余静态 key 保持原序。开源构建注册表恒空 → 原序不变。 */
export function allPresetKeys(): string[] {
  const staticKeys = providerPresetKeys as string[]
  const proKeys = proRegistry.keys()
  if (proKeys.length === 0) return [...staticKeys]
  const out = [...staticKeys]
  const insertAfter = out.indexOf('deepseek')
  out.splice(insertAfter + 1, 0, ...proKeys)
  // 去重：同名覆盖时保留单份（静态优先，pro 覆盖同名静态键）
  return [...new Set(out)]
}
