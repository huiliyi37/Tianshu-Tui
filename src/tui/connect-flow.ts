/**
 * Headless state machine for the in-TUI `/connect` provider setup wizard.
 *
 * Pure and side-effect free so it is fully unit-testable without a TUI runtime:
 * it only produces *view models* (what the overlay should render), *probe
 * requests* (the TUI runs the async probe and feeds the report back), and
 * *commit descriptors* (what config write to perform). The TUI layer owns
 * rendering and calls `setupProvider` / `registerProvider` on commit.
 *
 * Three paths:
 *   preset    → pick a built-in provider (URL/protocol/models auto-filled) →
 *               paste API key → done.
 *   custom    → base URL → API key → PROBE (models list + minimal completion)
 *               → multi-select probed models (alias-table metadata backfilled)
 *               → thinking capability → provider name → done. Multi-model; the
 *               old single-model `custom-<modelname>` mode is gone.
 *   add-model → append one model to an existing provider (no URL/key needed).
 */

import type { SetupProviderOptions } from '../config/manager.js'
import type { ModelConfig } from '../config/schema.js'
import { PROVIDER_PRESETS, providerPresetKeys, isProviderPresetKey, type ProviderPresetKey } from '../config/provider-presets.js'
import { matchModelIds, type ModelMatchResult } from '../api/model-id-matcher.js'
import type { ProbeReport } from '../api/provider-probe.js'

const CUSTOM_CHOICE = 'custom'
const DEFAULT_CONTEXT_WINDOW = 131_072
const DEFAULT_MAX_OUTPUT = 64_000
/** Providers the wizard recommends first (project is DeepSeek-optimized). */
const RECOMMENDED_PRESETS: readonly ProviderPresetKey[] = ['deepseek']

const CONFIG_HINT = '密钥将保存到 ~/.rivet/config.json（本机明文，可粘贴）'

export type ConnectStepKind = 'choice' | 'multi-choice' | 'input' | 'busy'

export interface ConnectChoiceOption {
  id: string
  label: string
  description?: string
  recommended?: boolean
  /** Checkbox state on multi-choice steps (space toggles). */
  checked?: boolean
}

/** What the TUI overlay should render for the current step. */
export interface ConnectView {
  kind: ConnectStepKind
  title: string
  subtitle?: string
  /** e.g. "步骤 2 / 5" — shown by the DIY multi-step flow. */
  stepLabel?: string
  /** choice / multi-choice steps */
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
      /** Empty for local endpoints (Ollama/vLLM) that need no auth. */
      apiKey?: string
      protocol: 'openai' | 'anthropic'
      /** Multi-model; partial entries are normalized by registerProvider. */
      models: Array<Partial<ModelConfig> & { id: string }>
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
  /** Async probe request — the TUI runs probeProvider and calls applyProbe/probeFailed. */
  | { kind: 'probe'; baseUrl: string; apiKey?: string; protocol: 'openai' | 'anthropic' }
  | { kind: 'commit'; commit: ConnectCommit; summary: string }

type Phase =
  | 'provider'
  | 'pick-existing'
  | 'preset-apikey'
  | 'diy-url'
  | 'diy-apikey'
  | 'diy-probing'
  | 'diy-probe-failed'
  | 'diy-models'
  | 'diy-model'
  | 'diy-context'
  | 'diy-vision'
  | 'diy-thinking'
  | 'diy-name'

/** A provider already configured on disk, offered by the add-model branch. */
export interface ConnectProviderRef {
  name: string
  label?: string
  modelCount: number
}

/** One probed model with its matcher result and checkbox state. */
interface ProbedModel {
  rawId: string
  match: ModelMatchResult
  checked: boolean
}

interface Collected {
  presetKey?: ProviderPresetKey
  baseUrl?: string
  apiKey?: string
  modelId?: string
  contextWindow?: number
  supportsVision?: boolean
  /** Set when the flow is adding a model to an existing provider (3-step path). */
  existingProvider?: string
  /** Capability hints from the endpoint probe (reasoning_content etc.). */
  reasoningSplitHint?: boolean
  /** Probe failure reason, shown on the probe-failed choice step. */
  probeError?: string
  /** True when the model list came from the probe (vs manual entry). */
  probedModels?: ProbedModel[]
  /** Thinking answer applied to models without declared thinking capabilities. */
  thinkingSplit?: boolean
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
    description: '填写 API 地址与密钥，自动探测模型列表（任意 OpenAI 兼容接口）',
  })
  return options
}

function slugify(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'model'
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

/** Default provider name from the base URL host: api.example.com → example-com. */
export function suggestProviderName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname
    const slug = slugify(host.replace(/^api\./, '').replace(/\./g, '-'))
    return slug || 'custom'
  } catch {
    return 'custom'
  }
}

function matchDescription(match: ModelMatchResult): string {
  if (!match.entry) return '未知模型——上下文长度按默认值落盘，可事后用 config 修改'
  if (match.tier === 'fuzzy') return `≈ ${match.entry.canonicalId}（低置信推断，元数据请核对）`
  return `已知模型 ${match.entry.canonicalId}，元数据自动回填`
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
      case 'diy-apikey':
        return {
          kind: 'input',
          title: '输入 API Key',
          subtitle: `${CONFIG_HINT}；本地端点（Ollama/vLLM）可直接回车跳过`,
          stepLabel: this.diyStepLabel(2),
          masked: true,
        }
      case 'diy-probing':
        return {
          kind: 'busy',
          title: '正在探测端点…',
          subtitle: '拉取模型列表（GET /models）并做一次最小补全，消耗极少量 token',
          stepLabel: this.diyStepLabel(3),
        }
      case 'diy-probe-failed':
        return {
          kind: 'choice',
          title: '端点探测未成功',
          subtitle: this.collected.probeError ?? '未能获取模型列表',
          stepLabel: this.diyStepLabel(3),
          options: [
            { id: 'manual', label: '手动输入模型型号', description: '跳过探测，直接填写模型信息' },
            { id: 'back', label: '返回修改 API 地址', description: '地址可能缺 /v1 后缀或拼写有误' },
          ],
        }
      case 'diy-models': {
        const probed = this.collected.probedModels ?? []
        return {
          kind: 'multi-choice',
          title: '选择要添加的模型',
          subtitle: '探测到的模型已按别名表回填元数据；空格取消不需要的项',
          stepLabel: this.diyStepLabel(3),
          options: probed.map((p, i) => ({
            id: String(i),
            label: p.rawId,
            description: matchDescription(p.match),
            checked: p.checked,
          })),
        }
      }
      case 'diy-model':
        return {
          kind: 'input',
          title: '输入模型型号',
          subtitle: this.collected.existingProvider
            ? '例如 deepseek-v4-flash'
            : '探测未发现模型列表——手动填写一个模型型号（例如 deepseek-v4-flash）',
          stepLabel: this.diyStepLabel(this.collected.existingProvider ? 2 : 3),
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
      case 'diy-thinking': {
        const split = this.collected.reasoningSplitHint === true
        return {
          kind: 'choice',
          title: '这些模型支持深度思考（reasoning）输出吗？',
          subtitle: split
            ? '探测发现端点返回 reasoning_content —— 建议选「支持」'
            : '支持思考输出的模型会启用思考档路由；不确定选「不支持」',
          stepLabel: this.diyStepLabel(4),
          options: [
            { id: 'none', label: '不支持（纯文本补全）', recommended: !split },
            { id: 'split', label: '支持（reasoning_content 分块返回）', recommended: split },
          ],
        }
      }
      case 'diy-name':
        return {
          kind: 'input',
          title: '给这个服务商起个名字',
          subtitle: '用于配置与切换（小写字母/数字/-/_），回车用建议名',
          stepLabel: this.diyStepLabel(5),
          placeholder: suggestProviderName(this.collected.baseUrl ?? ''),
          defaultValue: suggestProviderName(this.collected.baseUrl ?? ''),
        }
    }
  }

  /** Space on multi-choice steps: toggle a checkbox. */
  toggle(id: string): ConnectStepResult {
    if (this.phase !== 'diy-models') {
      return { kind: 'error', message: '当前步骤无可勾选项。', view: this.view() }
    }
    const probed = this.collected.probedModels ?? []
    const index = Number.parseInt(id, 10)
    if (!Number.isInteger(index) || index < 0 || index >= probed.length) {
      return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
    }
    probed[index]!.checked = !probed[index]!.checked
    return { kind: 'next', view: this.view() }
  }

  /** Enter on multi-choice steps: confirm the current checkbox selection. */
  confirm(): ConnectStepResult {
    if (this.phase !== 'diy-models') {
      return { kind: 'error', message: '当前步骤不支持确认操作。', view: this.view() }
    }
    const picked = (this.collected.probedModels ?? []).filter(p => p.checked)
    if (picked.length === 0) {
      return { kind: 'error', message: '请至少勾选一个模型（空格勾选，或 Esc 取消）。', view: this.view() }
    }
    this.collected.probedModels = picked
    this.phase = 'diy-thinking'
    return { kind: 'next', view: this.view() }
  }

  /**
   * Feed the async probe result back into the flow. Models present → multi-select
   * step; none → manual model entry. Probe errors that still yielded a model
   * list are non-fatal (completion-only failures).
   */
  applyProbe(report: ProbeReport): ConnectStepResult {
    if (this.phase !== 'diy-probing') {
      return { kind: 'error', message: '当前不在探测步骤。', view: this.view() }
    }
    this.collected.reasoningSplitHint = report.hints.reasoningSplit === true
    if (report.models.length > 0) {
      const matches = matchModelIds(report.models)
      this.collected.probedModels = matches.map(match => ({
        rawId: match.rawId,
        match,
        checked: true,
      }))
      this.phase = 'diy-models'
      return { kind: 'next', view: this.view() }
    }
    this.collected.probeError = report.errors.join('；') || '端点未返回模型列表'
    if (report.completionOk) {
      // Endpoint answers but exposes no /models — manual entry is the natural path.
      this.phase = 'diy-model'
      return { kind: 'next', view: this.view() }
    }
    this.phase = 'diy-probe-failed'
    return { kind: 'next', view: this.view() }
  }

  /** The TUI caught a network/timeout error while running the probe. */
  probeFailed(message: string): ConnectStepResult {
    if (this.phase !== 'diy-probing') {
      return { kind: 'error', message: '当前不在探测步骤。', view: this.view() }
    }
    this.collected.probeError = message
    this.phase = 'diy-probe-failed'
    return { kind: 'next', view: this.view() }
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
    if (this.phase === 'diy-thinking') {
      if (id !== 'none' && id !== 'split') {
        return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
      }
      this.collected.thinkingSplit = id === 'split'
      this.phase = 'diy-name'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase === 'diy-probe-failed') {
      if (id === 'manual') {
        this.phase = 'diy-model'
        return { kind: 'next', view: this.view() }
      }
      if (id === 'back') {
        this.phase = 'diy-url'
        return { kind: 'next', view: this.view() }
      }
      return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
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
      case 'diy-thinking':
      case 'diy-probe-failed':
      case 'diy-models':
        return { kind: 'error', message: '当前步骤需要选择，而非输入。', view: this.view() }
      case 'diy-probing':
        return { kind: 'error', message: '正在探测端点，请稍候…', view: this.view() }

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
        this.phase = 'diy-apikey'
        return { kind: 'next', view: this.view() }
      }

      case 'diy-apikey': {
        // Empty is allowed — local deployments (Ollama/vLLM) need no auth.
        this.collected.apiKey = value.length > 0 ? value : undefined
        this.phase = 'diy-probing'
        return {
          kind: 'probe',
          baseUrl: this.collected.baseUrl!,
          apiKey: this.collected.apiKey,
          protocol: 'openai',
        }
      }

      case 'diy-model': {
        if (value.length === 0) {
          return { kind: 'error', message: '模型型号不能为空。', view: this.view() }
        }
        this.collected.modelId = value
        if (this.collected.existingProvider) {
          this.phase = 'diy-context'
        } else {
          // DIY 单模型兜底路径（探测无果）：contextWindow/maxTokens 交给
          // modelConfigSchema 推断落盘，思考问句与多模型路径合流。
          this.phase = 'diy-thinking'
        }
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

      case 'diy-name': {
        const name = (value.length > 0 ? value : suggestProviderName(this.collected.baseUrl ?? '')).toLowerCase()
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
          return { kind: 'error', message: '名字只能包含小写字母、数字、.、_、-（且以字母/数字开头）。', view: this.view() }
        }
        if (isProviderPresetKey(name)) {
          return { kind: 'error', message: `「${name}」是内置服务商名——请换一个名字（配置内置服务商请在第一步直接选它）。`, view: this.view() }
        }
        return this.commitCustom(name)
      }
    }
  }

  /** Materialize the custom-provider commit from everything collected. */
  private commitCustom(providerName: string): ConnectStepResult {
    const models: Array<Partial<ModelConfig> & { id: string }> = []
    const probed = this.collected.probedModels
    if (probed && probed.length > 0) {
      for (const p of probed) {
        const descriptor = this.descriptorFor(p.match)
        models.push(descriptor)
      }
    } else {
      // Manual fallback — bare id; schema materializes contextWindow/maxTokens.
      models.push({ id: this.collected.modelId! })
    }
    return {
      kind: 'commit',
      commit: {
        mode: 'custom',
        providerName,
        baseUrl: this.collected.baseUrl!,
        apiKey: this.collected.apiKey,
        protocol: 'openai',
        models,
        makeDefault: true,
      },
      summary: `已连接 ${providerName} · ${models.length} 个模型`,
    }
  }

  /** Matcher result → config descriptor, keeping the RAW endpoint id callable. */
  private descriptorFor(match: ModelMatchResult): Partial<ModelConfig> & { id: string } {
    if (!match.entry) {
      // Unknown model: apply the thinking answer, leave sizes to schema defaults.
      const descriptor: Partial<ModelConfig> & { id: string } = { id: match.rawId }
      if (this.collected.thinkingSplit) descriptor.capabilities = { reasoningSplit: true }
      return descriptor
    }
    const metadata = match.entry.metadata
    const descriptor: Partial<ModelConfig> & { id: string } = {
      id: match.rawId,
      ...(metadata.contextWindow !== undefined ? { contextWindow: metadata.contextWindow } : {}),
      ...(metadata.maxTokens !== undefined ? { maxTokens: metadata.maxTokens } : {}),
      ...(metadata.reasoningEffort ? { reasoningEffort: metadata.reasoningEffort } : {}),
      ...(metadata.supportsVision !== undefined ? { supportsVision: true } : {}),
      ...(metadata.tier ? { tier: metadata.tier } : {}),
      ...(metadata.pricing ? { pricing: metadata.pricing } : {}),
    }
    const caps = { ...(metadata.capabilities ?? {}) }
    // Thinking answer only fills models that declare nothing themselves —
    // alias-table metadata wins over the blanket wizard answer.
    if (this.collected.thinkingSplit && caps.thinkingBlock === undefined && caps.reasoningSplit === undefined) {
      caps.reasoningSplit = true
    }
    if (Object.keys(caps).length > 0) descriptor.capabilities = caps
    return descriptor
  }

  /** True when the current step accepts free-text input (vs a choice list). */
  isInputStep(): boolean {
    return this.view().kind === 'input'
  }
}
