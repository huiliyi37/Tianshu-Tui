/**
 * Headless state machine for the in-TUI `/connect` provider setup wizard.
 *
 * Mirrors the polished catalog+DIY flow users praised in scream-code, but stays
 * pure and side-effect free so it is fully unit-testable without an Ink runtime:
 * it only produces *view models* (what the overlay should render) and *commit
 * descriptors* (what config write to perform). The TUI layer owns rendering and
 * calls `setupProvider` / `setupCustomProvider` on commit.
 *
 * Two paths:
 *   preset → pick a built-in provider (URL/protocol/models auto-filled) → paste
 *            API key → done. Zero URL typing for common providers.
 *   custom → base URL → model id → context window → API key → done.
 */

import type { SetupProviderOptions } from '../config/manager.js'
import { PROVIDER_PRESETS, providerPresetKeys, type ProviderPresetKey } from '../config/provider-presets.js'

const CUSTOM_CHOICE = 'custom'
const DEFAULT_CONTEXT_WINDOW = 131_072
const DEFAULT_MAX_OUTPUT = 64_000
/** Providers the wizard recommends first (project is DeepSeek-optimized). */
const RECOMMENDED_PRESETS: readonly ProviderPresetKey[] = ['deepseek']

const CONFIG_HINT = '密钥将保存到 ~/.rivet/config.json（本机明文，可粘贴）'

export type ConnectStepKind = 'choice' | 'input'

export interface ConnectChoiceOption {
  id: string
  label: string
  description?: string
  recommended?: boolean
}

/** What the TUI overlay should render for the current step. */
export interface ConnectView {
  kind: ConnectStepKind
  title: string
  subtitle?: string
  /** e.g. "步骤 2 / 4" — shown by the DIY multi-step flow. */
  stepLabel?: string
  /** choice step */
  options?: ConnectChoiceOption[]
  /** input step */
  masked?: boolean
  placeholder?: string
  defaultValue?: string
}

/** Config mutation to perform once the wizard reaches a terminal state. */
export type ConnectCommit =
  | { mode: 'preset'; setup: SetupProviderOptions }
  | {
      mode: 'custom'
      providerName: string
      baseUrl: string
      apiKey: string
      model: { id: string; alias: string; contextWindow: number; maxTokens: number; supportsVision?: boolean }
      makeDefault: boolean
    }
  | {
      mode: 'add-model'
      providerName: string
      model: { id: string; contextWindow: number; maxTokens: number; supportsVision?: boolean }
    }

export type ConnectStepResult =
  | { kind: 'next'; view: ConnectView }
  | { kind: 'error'; message: string; view: ConnectView }
  | { kind: 'commit'; commit: ConnectCommit; summary: string }

type Phase =
  | 'provider'
  | 'pick-existing'
  | 'preset-apikey'
  | 'diy-url'
  | 'diy-model'
  | 'diy-context'
  | 'diy-vision'
  | 'diy-apikey'

/** A provider already configured on disk, offered by the add-model branch. */
export interface ConnectProviderRef {
  name: string
  label?: string
  modelCount: number
}

interface Collected {
  presetKey?: ProviderPresetKey
  baseUrl?: string
  modelId?: string
  contextWindow?: number
  supportsVision?: boolean
  /** Set when the flow is adding a model to an existing provider (3-step path). */
  existingProvider?: string
}

const ADD_MODEL_CHOICE = 'existing'

function presetProviderOptions(): ConnectChoiceOption[] {
  const rank = (k: ProviderPresetKey): number => (RECOMMENDED_PRESETS.includes(k) ? 0 : 1)
  const options: ConnectChoiceOption[] = providerPresetKeys
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map(key => {
      const preset = PROVIDER_PRESETS[key]
      const oauth = preset.provider.auth?.type === 'oauth'
      return {
        id: key,
        label: oauth ? `${preset.label}（OAuth 登录）` : preset.label,
        description: preset.provider.baseUrl,
        recommended: RECOMMENDED_PRESETS.includes(key),
      }
    })
  options.push({
    id: CUSTOM_CHOICE,
    label: '自定义服务商…',
    description: '手动填写 API 地址 / 型号 / 密钥（任意 OpenAI 兼容接口）',
  })
  return options
}

function slugifyModelId(modelId: string): string {
  return modelId.replaceAll(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'model'
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

export class ConnectFlow {
  private phase: Phase = 'provider'
  private readonly collected: Collected = {}

  constructor(private readonly existing: ConnectProviderRef[] = []) {}

  /** n 是全路径编号（diy 5 步）；加模型路径少 url/apikey 两步，显示 n-1 / 3。 */
  private diyStepLabel(n: number): string {
    return this.collected.existingProvider ? `步骤 ${n - 1} / 3` : `步骤 ${n} / 5`
  }

  /** The view for the current step. */
  view(): ConnectView {
    switch (this.phase) {
      case 'provider': {
        const options = presetProviderOptions()
        if (this.existing.length > 0) {
          options.push({
            id: ADD_MODEL_CHOICE,
            label: '为已有服务商添加模型…',
            description: '给已配置的服务商追加一个模型（不改动现有配置）',
          })
        }
        return {
          kind: 'choice',
          title: '连接模型服务商',
          subtitle: '选择一个内置服务商（自动带出接口地址），或自定义',
          options,
        }
      }
      case 'pick-existing':
        return {
          kind: 'choice',
          title: '为哪个服务商添加模型？',
          subtitle: '选择已配置的服务商，只需填模型信息（无需 API 地址 / 密钥）',
          options: this.existing.map(p => ({
            id: p.name,
            label: p.label ?? p.name,
            description: `${p.modelCount} 个模型`,
          })),
        }
      case 'preset-apikey': {
        const preset = PROVIDER_PRESETS[this.collected.presetKey!]
        return {
          kind: 'input',
          title: `输入 ${preset.label} 的 API 密钥`,
          subtitle: CONFIG_HINT,
          masked: true,
        }
      }
      case 'diy-url':
        return {
          kind: 'input',
          title: '输入服务商 API 地址',
          subtitle: '例如 https://api.deepseek.com/v1（可粘贴）',
          stepLabel: '步骤 1 / 5',
          placeholder: 'https://',
        }
      case 'diy-model':
        return {
          kind: 'input',
          title: '输入模型型号',
          subtitle: '例如 deepseek-v4-flash',
          stepLabel: this.diyStepLabel(2),
        }
      case 'diy-context':
        return {
          kind: 'input',
          title: '模型最大上下文长度 (tokens)',
          // 上下文窗口驱动自动压缩阈值 —— 必须照模型服务商官方 API 的真实值填。
          // 填小了会过早压缩(丢上下文、碎缓存);填大了会撞 API 上限来不及自救。
          subtitle: '请照官方 API 文档的真实值填(它决定自动压缩点);DeepSeek V4 填 1000000,回车用默认',
          stepLabel: this.diyStepLabel(3),
          placeholder: String(DEFAULT_CONTEXT_WINDOW),
          defaultValue: String(DEFAULT_CONTEXT_WINDOW),
        }
      case 'diy-vision':
        return {
          kind: 'choice',
          title: '这个模型支持视觉（识图）吗？',
          subtitle: '支持图片输入的模型勾「是」，之后可在「识图」配置里选它做识图桥',
          stepLabel: this.diyStepLabel(4),
          options: [
            { id: 'no', label: '否（纯文本）' },
            { id: 'yes', label: '是（多模态，可识图）' },
          ],
        }
      case 'diy-apikey':
        return {
          kind: 'input',
          title: '输入 API Key',
          subtitle: CONFIG_HINT,
          stepLabel: this.diyStepLabel(5),
          masked: true,
        }
    }
  }

  /** Advance a choice step. Invalid for input steps. */
  submitChoice(id: string): ConnectStepResult {
    if (this.phase === 'diy-vision') {
      this.collected.supportsVision = id === 'yes'
      if (this.collected.existingProvider) {
        // 加模型路径到此结束——provider 已存在，无需 API Key。
        const providerName = this.collected.existingProvider
        const modelId = this.collected.modelId!
        const contextWindow = this.collected.contextWindow ?? DEFAULT_CONTEXT_WINDOW
        return {
          kind: 'commit',
          commit: {
            mode: 'add-model',
            providerName,
            model: {
              id: modelId,
              contextWindow,
              maxTokens: Math.min(DEFAULT_MAX_OUTPUT, contextWindow),
              ...(this.collected.supportsVision ? { supportsVision: true } : {}),
            },
          },
          summary: `已为 ${providerName} 添加模型 ${modelId}`,
        }
      }
      this.phase = 'diy-apikey'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase === 'pick-existing') {
      const ref = this.existing.find(p => p.name === id)
      if (!ref) {
        return { kind: 'error', message: `未知服务商：${id}`, view: this.view() }
      }
      this.collected.existingProvider = ref.name
      this.phase = 'diy-model'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase !== 'provider') {
      return { kind: 'error', message: '当前步骤需要输入文本，而非选择。', view: this.view() }
    }
    if (id === CUSTOM_CHOICE) {
      this.phase = 'diy-url'
      return { kind: 'next', view: this.view() }
    }
    if (id === ADD_MODEL_CHOICE) {
      this.phase = 'pick-existing'
      return { kind: 'next', view: this.view() }
    }
    const key = id as ProviderPresetKey
    const preset = PROVIDER_PRESETS[key]
    if (!preset) {
      return { kind: 'error', message: `未知服务商：${id}`, view: this.view() }
    }
    // OAuth providers (codex) need no API key — commit the preset directly and
    // point the user at the separate login step.
    if (preset.provider.auth?.type === 'oauth') {
      return {
        kind: 'commit',
        commit: { mode: 'preset', setup: { providerName: key, preset: key, makeDefault: true } },
        summary: `已选择 ${preset.label} · ${preset.defaultModelId}（OAuth）。请运行 /login 完成登录。`,
      }
    }
    this.collected.presetKey = key
    this.phase = 'preset-apikey'
    return { kind: 'next', view: this.view() }
  }

  /** Advance an input step. Invalid for choice steps. */
  submitInput(raw: string): ConnectStepResult {
    const value = raw.trim()
    switch (this.phase) {
      case 'provider':
      case 'pick-existing':
      case 'diy-vision':
        return { kind: 'error', message: '当前步骤需要选择，而非输入。', view: this.view() }

      case 'preset-apikey': {
        if (value.length === 0) {
          return { kind: 'error', message: 'API 密钥不能为空。', view: this.view() }
        }
        const key = this.collected.presetKey!
        const preset = PROVIDER_PRESETS[key]
        return {
          kind: 'commit',
          commit: { mode: 'preset', setup: { providerName: key, preset: key, apiKey: value, makeDefault: true } },
          summary: `已连接 ${preset.label} · ${preset.defaultModelId}`,
        }
      }

      case 'diy-url': {
        if (!isLikelyUrl(value)) {
          return { kind: 'error', message: '请填写合法的 http(s) 地址。', view: this.view() }
        }
        this.collected.baseUrl = value
        this.phase = 'diy-model'
        return { kind: 'next', view: this.view() }
      }

      case 'diy-model': {
        if (value.length === 0) {
          return { kind: 'error', message: '模型型号不能为空。', view: this.view() }
        }
        this.collected.modelId = value
        this.phase = 'diy-context'
        return { kind: 'next', view: this.view() }
      }

      case 'diy-context': {
        let contextWindow = DEFAULT_CONTEXT_WINDOW
        if (value.length > 0) {
          const parsed = Number.parseInt(value, 10)
          if (!Number.isInteger(parsed) || parsed <= 0) {
            return { kind: 'error', message: '上下文长度需为正整数（或直接回车用默认）。', view: this.view() }
          }
          contextWindow = parsed
        }
        this.collected.contextWindow = contextWindow
        this.phase = 'diy-vision'
        return { kind: 'next', view: this.view() }
      }

      case 'diy-apikey': {
        if (value.length === 0) {
          return { kind: 'error', message: 'API 密钥不能为空。', view: this.view() }
        }
        const modelId = this.collected.modelId!
        const contextWindow = this.collected.contextWindow ?? DEFAULT_CONTEXT_WINDOW
        const providerName = `custom-${slugifyModelId(modelId)}`
        return {
          kind: 'commit',
          commit: {
            mode: 'custom',
            providerName,
            baseUrl: this.collected.baseUrl!,
            apiKey: value,
            model: {
              id: modelId,
              alias: slugifyModelId(modelId),
              contextWindow,
              maxTokens: Math.min(DEFAULT_MAX_OUTPUT, contextWindow),
              ...(this.collected.supportsVision ? { supportsVision: true } : {}),
            },
            makeDefault: true,
          },
          summary: `已连接 ${providerName} · ${modelId}`,
        }
      }
    }
  }

  /** True when the current step accepts free-text input (vs a choice list). */
  isInputStep(): boolean {
    return this.view().kind === 'input'
  }
}
