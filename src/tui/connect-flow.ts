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
      model: { id: string; alias: string; contextWindow: number; maxTokens: number }
      makeDefault: boolean
    }

export type ConnectStepResult =
  | { kind: 'next'; view: ConnectView }
  | { kind: 'error'; message: string; view: ConnectView }
  | { kind: 'commit'; commit: ConnectCommit; summary: string }

type Phase =
  | 'provider'
  | 'preset-apikey'
  | 'diy-url'
  | 'diy-model'
  | 'diy-context'
  | 'diy-apikey'

interface Collected {
  presetKey?: ProviderPresetKey
  baseUrl?: string
  modelId?: string
  contextWindow?: number
}

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

  /** The view for the current step. */
  view(): ConnectView {
    switch (this.phase) {
      case 'provider':
        return {
          kind: 'choice',
          title: '连接模型服务商',
          subtitle: '选择一个内置服务商（自动带出接口地址），或自定义',
          options: presetProviderOptions(),
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
          stepLabel: '步骤 1 / 4',
          placeholder: 'https://',
        }
      case 'diy-model':
        return {
          kind: 'input',
          title: '输入模型型号',
          subtitle: '例如 deepseek-v4-flash',
          stepLabel: '步骤 2 / 4',
        }
      case 'diy-context':
        return {
          kind: 'input',
          title: '模型最大上下文长度 (tokens)',
          // 上下文窗口驱动自动压缩阈值 —— 必须照模型服务商官方 API 的真实值填。
          // 填小了会过早压缩(丢上下文、碎缓存);填大了会撞 API 上限来不及自救。
          subtitle: '请照官方 API 文档的真实值填(它决定自动压缩点);DeepSeek V4 填 1000000,回车用默认',
          stepLabel: '步骤 3 / 4',
          placeholder: String(DEFAULT_CONTEXT_WINDOW),
          defaultValue: String(DEFAULT_CONTEXT_WINDOW),
        }
      case 'diy-apikey':
        return {
          kind: 'input',
          title: '输入 API Key',
          subtitle: CONFIG_HINT,
          stepLabel: '步骤 4 / 4',
          masked: true,
        }
    }
  }

  /** Advance a choice step. Invalid for input steps. */
  submitChoice(id: string): ConnectStepResult {
    if (this.phase !== 'provider') {
      return { kind: 'error', message: '当前步骤需要输入文本，而非选择。', view: this.view() }
    }
    if (id === CUSTOM_CHOICE) {
      this.phase = 'diy-url'
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
        this.phase = 'diy-apikey'
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
