/**
 * Declarative field table behind the in-TUI `/config` settings panel.
 *
 * Pure data + pure functions: no config I/O, no rendering. The panel reads a
 * `SettingsDraft` snapshot (taken once when the overlay opens), mutates it
 * immutably through each field's `apply`, and `settings-persist.ts` maps the
 * dirty blocks back onto the real config setters.
 *
 * Dirty tracking is *structural* — `dirtyBlocks()` compares the draft against
 * the baseline per block rather than trusting a flag, so changing a value and
 * changing it back writes nothing.
 */

import type { ReviewConfig, WorkersConfig } from '../config/schema.js'

/**
 * Save granularity. Each id maps to exactly one config setter in
 * settings-persist.ts, so only the blocks the user actually touched get written.
 */
export type SettingsBlockId =
  | 'workers'
  | 'review'
  | 'vision'
  | 'visionAuto'
  | 'modelVision'
  | 'toolPreset'
  | 'approval'
  | 'checkpoint'
  | 'defaultDomain'
  | 'defaultModel'
  | 'mirrors'
  | 'network'
  | 'search'

/** When a saved value starts mattering. Shown next to every field. */
export type SettingsEffect = 'immediate' | 'next-session'

export type SettingsFieldKind = 'enum' | 'bool' | 'text' | 'int' | 'action'

export interface SettingsOption {
  id: string
  label: string
}

export interface VisionDraft {
  provider: string
  model: string
  prompt?: string
  maxTokens: number
  /** 备用识图桥（主桥 5xx/超时时切）。必须在 draft 里往返，否则面板一保存就把它
   *  抹掉——桌面端与手写配置都可能设了它，面板不该删掉自己不显示的字段。 */
  fallback?: { provider: string; model: string }
}

export interface BasicsDraft {
  toolPreset: string
  approval: string
  checkpointEveryTurns: number
  defaultDomain: string
  /** `provider:modelId`, or '' when unset. */
  defaultModel: string
}

export interface NetDraft {
  mirrorsEnabled: boolean
  mirrorsPreset: string
  proxy: string
  noProxy: string
  /** Comma-separated backend chain, edited as free text. */
  searchBackends: string
  /** Jina Reader base URL（国内可填自建反代）。 */
  jinaBaseUrl: string
}

export interface SettingsDraft {
  workers: WorkersConfig
  review: ReviewConfig
  vision: VisionDraft | null
  /** `agent.visionAutoBridge` — own block: it matters precisely when `vision` is
   *  null, so it cannot live inside the nullable vision draft. */
  visionAutoBridge: boolean
  /** 每模型的 supportsVision 覆盖（key = `provider:modelId`）。
   *  /config 面板可事后给已有模型补标/去标视觉能力，不必手改 config.json。 */
  modelVision: Record<string, boolean>
  basics: BasicsDraft
  net: NetDraft
}

/** Choices that come from the environment rather than the draft itself. */
export interface SettingsEnv {
  models: { provider: string; id: string; alias?: string; supportsVision: boolean }[]
  domains: { key: string; name: string }[]
}

export interface SettingsField {
  id: string
  label: string
  kind: SettingsFieldKind
  block: SettingsBlockId
  effect: SettingsEffect
  hint?: string
  /** Current value as a display string. */
  display: (draft: SettingsDraft, env: SettingsEnv) => string
  /**
   * `text` / `int` only: the value to seed the edit buffer with. Separate from
   * `display` because display substitutes placeholder labels like "（未设置）",
   * and pre-filling the editor with one of those would make the user delete a
   * label to type a value.
   */
  raw?: (draft: SettingsDraft) => string
  /** `enum` only: selectable options. */
  options?: (draft: SettingsDraft, env: SettingsEnv) => SettingsOption[]
  /** `enum` only: which option is current, so the picker opens on it. */
  selectedId?: (draft: SettingsDraft) => string
  /** Everything but `action`: write a value, or refuse it with a reason. */
  apply?: (draft: SettingsDraft, value: string) => SettingsDraft | { error: string }
  /** `action` only: one-shot mutation (e.g. clearing the vision bridge). */
  run?: (draft: SettingsDraft) => SettingsDraft
}

export interface SettingsCategory {
  id: string
  label: string
  fields: SettingsField[]
}

export const APPROVAL_OPTIONS: readonly SettingsOption[] = [
  { id: 'auto-safe', label: 'auto-safe — 只读工具免审批，写操作要确认' },
  { id: 'manual', label: 'manual — 每个工具都要确认' },
  { id: 'auto-accept', label: 'auto-accept — 写操作也免审批' },
  { id: 'dangerously-skip-permissions', label: 'dangerously-skip-permissions — 全免（危险）' },
]

export const TOOL_PRESET_OPTIONS: readonly SettingsOption[] = [
  { id: 'minimal', label: 'minimal — 27 个工具（省 token）' },
  { id: 'frontend', label: 'frontend — 28 个，含 browser_debug（默认）' },
  { id: 'full', label: 'full — 47 个全集，含 computer_use / 办公工具' },
]

export const MIRROR_PRESET_OPTIONS: readonly SettingsOption[] = [
  { id: 'default', label: 'default — 不用镜像' },
  { id: 'china', label: 'china — 国内镜像' },
]

const TIER_OPTIONS: readonly SettingsOption[] = [
  { id: 'cheap', label: 'cheap' },
  { id: 'balanced', label: 'balanced' },
  { id: 'strong', label: 'strong' },
]

const ESCALATION_OPTIONS: readonly SettingsOption[] = [
  { id: 'off', label: 'off — 不因失败升档' },
  { id: 'balanced', label: 'balanced — 最多升到 balanced' },
  { id: 'strong', label: 'strong — 允许升到 strong' },
]

/**
 * Worker task keys offered by the panel.
 *
 * Union of the schema defaults (`workerRoutingSchema`) and the desktop UI list:
 * desktop shows `compaction` but omits `planning`, which is a gap on its side —
 * hiding a routable task means the user cannot see where it goes.
 */
export const WORKER_TASK_KEYS: readonly string[] = [
  'repo_summarization',
  'code_edit',
  'test_failure_diagnosis',
  'risky_refactor',
  'planning',
  'compaction',
]

/** 子代理任务类型 → 用户可读描述（路由字段 hint 用）。 */
const WORKER_TASK_HINTS: Record<string, string> = {
  repo_summarization: '仓库摘要：只读摸底任务',
  code_edit: '代码编辑：写补丁的 patcher 工蜂',
  test_failure_diagnosis: '测试失败诊断：只读分析测试报错',
  risky_refactor: '高风险重构：跨模块改写',
  planning: '规划：只读出计划不写实现',
  compaction: '上下文压缩：总结对话历史',
}

/** Review sub-agent profiles that accept a per-profile model override. */
export const REVIEW_PROFILE_KEYS: readonly string[] = [
  'reviewer',
  'adversarial_verifier',
  'verifier',
  'patcher',
  'council_expert',
  'code_scout',
  'doc_scout',
]

/** 审查/子代理 profile → 用户可读描述（路由字段 hint 用）。 */
const REVIEW_PROFILE_HINTS: Record<string, string> = {
  reviewer: '审查员：L1/L2 对抗验证',
  adversarial_verifier: '对抗验证器：找反证与边界',
  verifier: '验证器：跑测试/构建确认',
  patcher: '写工蜂：git worktree 隔离写补丁',
  council_expert: '议事会专家：只读出观点',
  code_scout: '代码侦察：只读搜索/结构探索',
  doc_scout: '文档侦察：只读研究文档',
}

const INHERIT = ''
const INHERIT_LABEL = '（继承会话模型）'
const UNSET_LABEL = '（未设置）'
const OFF_LABEL = '（关闭）'

function modelRef(provider: string, id: string): string {
  return `${provider}:${id}`
}

function modelOptions(env: SettingsEnv, opts?: { visionOnly?: boolean }): SettingsOption[] {
  return env.models
    .filter(m => (opts?.visionOnly ? m.supportsVision : true))
    .map(m => ({ id: modelRef(m.provider, m.id), label: `${m.provider} · ${m.id}` }))
}

export function splitModelRef(ref: string): { provider: string; model: string } | null {
  const idx = ref.indexOf(':')
  if (idx < 1 || idx === ref.length - 1) return null
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) }
}

function parseBool(value: string): boolean {
  return value === 'true' || value === 'on' || value === '1'
}

const BOOL_OPTIONS: readonly SettingsOption[] = [
  { id: 'true', label: '开' },
  { id: 'false', label: '关' },
]

function boolField(input: {
  id: string
  label: string
  block: SettingsBlockId
  effect: SettingsEffect
  hint?: string
  get: (draft: SettingsDraft) => boolean
  set: (draft: SettingsDraft, value: boolean) => SettingsDraft
}): SettingsField {
  return {
    id: input.id,
    label: input.label,
    kind: 'bool',
    block: input.block,
    effect: input.effect,
    hint: input.hint,
    display: draft => (input.get(draft) ? '开' : '关'),
    options: () => [...BOOL_OPTIONS],
    selectedId: draft => String(input.get(draft)),
    apply: (draft, value) => input.set(draft, parseBool(value)),
  }
}

function enumField(input: {
  id: string
  label: string
  block: SettingsBlockId
  effect: SettingsEffect
  hint?: string
  options: readonly SettingsOption[]
  get: (draft: SettingsDraft) => string
  set: (draft: SettingsDraft, value: string) => SettingsDraft
}): SettingsField {
  return {
    id: input.id,
    label: input.label,
    kind: 'enum',
    block: input.block,
    effect: input.effect,
    hint: input.hint,
    display: draft => input.get(draft) || UNSET_LABEL,
    options: () => [...input.options],
    selectedId: input.get,
    apply: (draft, value) => {
      if (!input.options.some(o => o.id === value)) return { error: `未知取值：${value}` }
      return input.set(draft, value)
    },
  }
}

function textField(input: {
  id: string
  label: string
  block: SettingsBlockId
  effect: SettingsEffect
  hint?: string
  get: (draft: SettingsDraft) => string
  set: (draft: SettingsDraft, value: string) => SettingsDraft
  placeholderLabel?: string
  /** Refuse the edit with a reason (e.g. depends on another field being set). */
  guard?: (draft: SettingsDraft) => string | undefined
}): SettingsField {
  return {
    id: input.id,
    label: input.label,
    kind: 'text',
    block: input.block,
    effect: input.effect,
    hint: input.hint,
    display: draft => input.get(draft) || (input.placeholderLabel ?? UNSET_LABEL),
    raw: input.get,
    apply: (draft, value) => {
      const blocked = input.guard?.(draft)
      if (blocked) return { error: blocked }
      return input.set(draft, value.trim())
    },
  }
}

function intField(input: {
  id: string
  label: string
  block: SettingsBlockId
  effect: SettingsEffect
  hint?: string
  min: number
  get: (draft: SettingsDraft) => number
  set: (draft: SettingsDraft, value: number) => SettingsDraft
  guard?: (draft: SettingsDraft) => string | undefined
}): SettingsField {
  return {
    id: input.id,
    label: input.label,
    kind: 'int',
    block: input.block,
    effect: input.effect,
    hint: input.hint,
    display: draft => String(input.get(draft)),
    raw: draft => String(input.get(draft)),
    apply: (draft, raw) => {
      const blocked = input.guard?.(draft)
      if (blocked) return { error: blocked }
      const value = Number.parseInt(raw.trim(), 10)
      if (!Number.isInteger(value) || value < input.min) {
        return { error: `需为不小于 ${input.min} 的整数` }
      }
      return input.set(draft, value)
    },
  }
}

/** A model-reference field: one flat `provider · model` list, like `/model`. */
function modelField(input: {
  id: string
  label: string
  block: SettingsBlockId
  effect: SettingsEffect
  hint?: string
  visionOnly?: boolean
  /** Sentinel option offered above the models (inherit / unset). */
  sentinel?: { id: string; label: string }
  get: (draft: SettingsDraft) => string
  set: (draft: SettingsDraft, ref: string) => SettingsDraft
  /** Refuse the edit with a reason (e.g. depends on another field being set). */
  guard?: (draft: SettingsDraft) => string | undefined
}): SettingsField {
  return {
    id: input.id,
    label: input.label,
    kind: 'enum',
    block: input.block,
    effect: input.effect,
    hint: input.hint,
    display: draft => {
      const ref = input.get(draft)
      if (!ref) return input.sentinel?.label ?? UNSET_LABEL
      const parts = splitModelRef(ref)
      return parts ? `${parts.provider} · ${parts.model}` : ref
    },
    options: (_draft, env) => {
      const list = modelOptions(env, { visionOnly: input.visionOnly })
      return input.sentinel ? [{ id: input.sentinel.id, label: input.sentinel.label }, ...list] : list
    },
    selectedId: input.get,
    apply: (draft, value) => {
      const blocked = input.guard?.(draft)
      if (blocked) return { error: blocked }
      if (value === INHERIT) return input.set(draft, INHERIT)
      if (!splitModelRef(value)) return { error: '模型格式需为 provider:modelId' }
      return input.set(draft, value)
    },
  }
}

function withWorkers(draft: SettingsDraft, workers: WorkersConfig): SettingsDraft {
  return { ...draft, workers }
}

function withReview(draft: SettingsDraft, review: ReviewConfig): SettingsDraft {
  return { ...draft, review }
}

function withBasics(draft: SettingsDraft, patch: Partial<BasicsDraft>): SettingsDraft {
  return { ...draft, basics: { ...draft.basics, ...patch } }
}

function withNet(draft: SettingsDraft, patch: Partial<NetDraft>): SettingsDraft {
  return { ...draft, net: { ...draft.net, ...patch } }
}

/** Profile names available as routing targets, plus anything already referenced. */
function profileOptions(draft: SettingsDraft): SettingsOption[] {
  const names = new Set(Object.keys(draft.workers.profiles))
  for (const target of Object.values(draft.workers.routing)) names.add(target)
  return [...names].sort().map(name => {
    const p = draft.workers.profiles[name]
    return { id: name, label: p ? `${name} → ${p.provider} · ${p.model}` : `${name}（未定义）` }
  })
}

function workerCategory(draft: SettingsDraft): SettingsCategory {
  const taskKeys = [...new Set([...WORKER_TASK_KEYS, ...Object.keys(draft.workers.routing)])]
  const fields: SettingsField[] = taskKeys.map(task => ({
    id: `workers.routing.${task}`,
    label: `路由 ${task}`,
    kind: 'enum' as const,
    block: 'workers' as const,
    effect: 'next-session' as const,
    hint: WORKER_TASK_HINTS[task] ?? `「${task}」类子代理任务走哪个档位`,
    display: d => d.workers.routing[task] ?? UNSET_LABEL,
    options: d => profileOptions(d),
    selectedId: d => d.workers.routing[task] ?? '',
    apply: (d, value) => withWorkers(d, { ...d.workers, routing: { ...d.workers.routing, [task]: value } }),
  }))

  // Editing an existing profile's model. Adding/removing profiles is out of
  // scope for v1 — routing can only point at names that already exist.
  for (const name of Object.keys(draft.workers.profiles).sort()) {
    fields.push(modelField({
      id: `workers.profiles.${name}`,
      label: `档位 ${name}`,
      block: 'workers',
      effect: 'next-session',
      hint: `「${name}」档位用哪个 provider/模型（路由按任务类型指向档位）`,
      get: d => {
        const p = d.workers.profiles[name]
        return p ? modelRef(p.provider, p.model) : ''
      },
      set: (d, ref) => {
        const parts = splitModelRef(ref)
        if (!parts) return d
        return withWorkers(d, {
          ...d.workers,
          profiles: { ...d.workers.profiles, [name]: { provider: parts.provider, model: parts.model } },
        })
      },
    }))
  }

  fields.push(enumField({
    id: 'workers.patcherTier',
    label: '天梁 patcher 档位',
    block: 'workers',
    effect: 'next-session',
    hint: 'patcher 工蜂的模型能力地板（cheap/balanced/strong）；路由只抬不降',
    options: TIER_OPTIONS,
    get: d => d.workers.patcherTier,
    set: (d, value) => withWorkers(d, { ...d.workers, patcherTier: value as WorkersConfig['patcherTier'] }),
  }))
  fields.push(enumField({
    id: 'workers.escalationCap',
    label: '失败升档天花板',
    block: 'workers',
    effect: 'next-session',
    hint: '子代理失败时最多升到哪档模型（cheap→balanced→strong），到顶仍失败走断路器',
    options: ESCALATION_OPTIONS,
    get: d => d.workers.escalationCap,
    set: (d, value) => withWorkers(d, { ...d.workers, escalationCap: value as WorkersConfig['escalationCap'] }),
  }))

  return { id: 'workers', label: '子代理模型路由', fields }
}

function reviewCategory(draft: SettingsDraft): SettingsCategory {
  const names = [...new Set([...REVIEW_PROFILE_KEYS, ...Object.keys(draft.review.profiles)])]
  const fields: SettingsField[] = names.map(name => modelField({
    id: `review.profiles.${name}`,
    label: name,
    block: 'review',
    effect: 'next-session',
    hint: REVIEW_PROFILE_HINTS[name] ?? `「${name}」类子代理用哪个模型；留空回退主控`,
    sentinel: { id: INHERIT, label: INHERIT_LABEL },
    get: d => {
      const p = d.review.profiles[name]
      return p ? modelRef(p.provider, p.model) : INHERIT
    },
    set: (d, ref) => {
      const next = { ...d.review.profiles }
      const parts = ref ? splitModelRef(ref) : null
      if (parts) next[name] = { provider: parts.provider, model: parts.model }
      else delete next[name]
      return withReview(d, { ...d.review, profiles: next })
    },
  }))

  fields.push(boolField({
    id: 'review.skipAuto',
    label: '跳过交付后自动审查',
    block: 'review',
    effect: 'next-session',
    hint: '开箱默认开（不自动审查）；手动 /review 永远放行，不受此开关影响',
    get: d => d.review.skipAuto,
    set: (d, value) => withReview(d, { ...d.review, skipAuto: value }),
  }))
  fields.push(boolField({
    id: 'review.mechanicalFastPath',
    label: '机械变更走快路径',
    block: 'review',
    effect: 'next-session',
    hint: '格式化/重命名等机械改动跳过重型审查（减少无意义消耗）',
    get: d => d.review.mechanicalFastPath,
    set: (d, value) => withReview(d, { ...d.review, mechanicalFastPath: value }),
  }))

  return { id: 'review', label: '审查与子代理模型', fields }
}

function visionCategory(env: SettingsEnv): SettingsCategory {
  const fields: SettingsField[] = [
    modelField({
      id: 'vision.model',
      label: '识图模型',
      block: 'vision',
      effect: 'next-session',
      visionOnly: true,
      sentinel: { id: INHERIT, label: OFF_LABEL },
      hint: '主控不支持识图时才需配桥；想免费识图先 /connect zhipu-vision，选 glm-4v-flash（智谱完全免费）',
      get: d => (d.vision ? modelRef(d.vision.provider, d.vision.model) : INHERIT),
      set: (d, ref) => {
        const parts = ref ? splitModelRef(ref) : null
        if (!parts) return { ...d, vision: null }
        return {
          ...d,
          vision: {
            provider: parts.provider,
            model: parts.model,
            prompt: d.vision?.prompt,
            maxTokens: d.vision?.maxTokens ?? 1024,
            fallback: d.vision?.fallback,
          },
        }
      },
    }),
    modelField({
      id: 'vision.fallback',
      label: '备用识图模型',
      block: 'vision',
      effect: 'next-session',
      visionOnly: true,
      sentinel: { id: INHERIT, label: OFF_LABEL },
      hint: '主识图模型 5xx / 超时时自动切到它；不设即单桥',
      guard: d => (d.vision ? undefined : '先选一个识图模型，再设备用'),
      get: d => (d.vision?.fallback ? modelRef(d.vision.fallback.provider, d.vision.fallback.model) : INHERIT),
      set: (d, ref) => {
        if (!d.vision) return d
        const parts = ref ? splitModelRef(ref) : null
        return { ...d, vision: { ...d.vision, fallback: parts ? { provider: parts.provider, model: parts.model } : undefined } }
      },
    }),
    textField({
      id: 'vision.prompt',
      label: '描述提示词',
      block: 'vision',
      effect: 'next-session',
      placeholderLabel: '（用默认提示词）',
      guard: d => (d.vision ? undefined : '先选一个识图模型，再改提示词'),
      get: d => d.vision?.prompt ?? '',
      set: (d, value) => (d.vision ? { ...d, vision: { ...d.vision, prompt: value || undefined } } : d),
    }),
    intField({
      id: 'vision.maxTokens',
      label: '描述输出上限',
      block: 'vision',
      effect: 'next-session',
      min: 1,
      guard: d => (d.vision ? undefined : '先选一个识图模型，再改输出上限'),
      get: d => d.vision?.maxTokens ?? 1024,
      set: (d, value) => (d.vision ? { ...d, vision: { ...d.vision, maxTokens: value } } : d),
    }),
    boolField({
      id: 'vision.autoBridge',
      label: '未配置时自动选桥',
      block: 'visionAuto',
      effect: 'next-session',
      hint: '没指定识图模型时自动挑一个可用的视觉模型（含免费 glm-4v-flash）——图片会发给那个 provider，默认关',
      get: d => d.visionAutoBridge,
      set: (d, value) => ({ ...d, visionAutoBridge: value }),
    }),
  ]

  // 事后给已有模型补标/去标视觉能力——每模型一个 toggle。
  // env.models 来自所有 provider 的 model 卡；draft.modelVision 存覆盖值。
  for (const m of env.models) {
    const ref = modelRef(m.provider, m.id)
    fields.push(boolField({
      id: `modelVision.${ref}`,
      label: `视觉：${m.provider} · ${m.alias ?? m.id}`,
      block: 'modelVision',
      effect: 'next-session',
      hint: `勾选后该模型可作识图桥（${m.provider}/${m.id}）。/connect 建模型时没选「支持视觉」的可在此补标`,
      get: d => d.modelVision[ref] ?? m.supportsVision,
      set: (d, value) => ({ ...d, modelVision: { ...d.modelVision, [ref]: value } }),
    }))
  }

  return { id: 'vision', label: '识图模型', fields }
}

function basicsCategory(): SettingsCategory {
  const fields: SettingsField[] = [
    enumField({
      id: 'tools.preset',
      label: '工具档位',
      block: 'toolPreset',
      effect: 'next-session',
      hint: '控制装配的工具数量：frontend 默认（28，含 browser_debug）；full 全集但占更多 system prompt',
      options: TOOL_PRESET_OPTIONS,
      get: d => d.basics.toolPreset,
      set: (d, value) => withBasics(d, { toolPreset: value }),
    }),
    enumField({
      id: 'agent.approval',
      label: '审批模式',
      block: 'approval',
      effect: 'immediate',
      hint: '控制工具执行的审批力度：auto-safe 低风险自动/高风险确认；dangerously-skip 全免（危险）',
      options: APPROVAL_OPTIONS,
      get: d => d.basics.approval,
      set: (d, value) => withBasics(d, { approval: value }),
    }),
    intField({
      id: 'agent.checkpointEveryTurns',
      label: '检查点间隔（回合，0=关）',
      block: 'checkpoint',
      effect: 'next-session',
      min: 0,
      hint: 'Auto 模式下每 N 轮暂停同步进度摘要（0=关闭）；检查点是 git 级粗粒度回滚锚点',
      get: d => d.basics.checkpointEveryTurns,
      set: (d, value) => withBasics(d, { checkpointEveryTurns: value }),
    }),
    {
      id: 'agent.defaultDomain',
      label: '默认星域',
      kind: 'enum',
      block: 'defaultDomain',
      effect: 'next-session',
      hint: '新会话的起始星域（改变方法论与决策阈值，不改工具）；留空走默认域启明',
      display: d => d.basics.defaultDomain || UNSET_LABEL,
      options: (_d, env) => env.domains.map(x => ({ id: x.key, label: `${x.key} — ${x.name}` })),
      selectedId: d => d.basics.defaultDomain,
      apply: (d, value) => (value.trim() ? withBasics(d, { defaultDomain: value.trim() }) : { error: '星域不能为空' }),
    },
    modelField({
      id: 'agent.defaultModel',
      label: '默认模型',
      block: 'defaultModel',
      effect: 'next-session',
      hint: '新会话的起始模型；当前会话仍用 /model 切换',
      get: d => d.basics.defaultModel,
      set: (d, ref) => withBasics(d, { defaultModel: ref }),
    }),
  ]
  return { id: 'basics', label: '基础行为', fields }
}

function netCategory(): SettingsCategory {
  const fields: SettingsField[] = [
    boolField({
      id: 'mirrors.enabled',
      label: '国内镜像',
      block: 'mirrors',
      effect: 'next-session',
      hint: '加速 npm/github/pypi/go/rust 拉取（GFW 用户建议开）；下次 bash 执行时生效，无需重启',
      get: d => d.net.mirrorsEnabled,
      set: (d, value) => withNet(d, { mirrorsEnabled: value }),
    }),
    enumField({
      id: 'mirrors.preset',
      label: '镜像预设',
      block: 'mirrors',
      effect: 'next-session',
      hint: 'china 一键应用五生态国内镜像（推荐）；default 逐个自选',
      options: MIRROR_PRESET_OPTIONS,
      get: d => d.net.mirrorsPreset,
      set: (d, value) => withNet(d, { mirrorsPreset: value }),
    }),
    textField({
      id: 'network.proxy',
      label: '代理地址',
      block: 'network',
      effect: 'next-session',
      hint: '如 http://127.0.0.1:7890；留空则跟随 HTTPS_PROXY 环境变量',
      placeholderLabel: '（跟随环境变量）',
      get: d => d.net.proxy,
      set: (d, value) => withNet(d, { proxy: value }),
    }),
    textField({
      id: 'network.noProxy',
      label: '不走代理的域名',
      block: 'network',
      effect: 'next-session',
      hint: '逗号分隔，语义对齐 curl 的 NO_PROXY',
      placeholderLabel: '（跟随环境变量）',
      get: d => d.net.noProxy,
      set: (d, value) => withNet(d, { noProxy: value }),
    }),
    textField({
      id: 'search.backends',
      label: 'web_search 后端链',
      block: 'search',
      effect: 'next-session',
      hint: '逗号分隔，按顺序 fallback，首个有结果即停',
      get: d => d.net.searchBackends,
      set: (d, value) => withNet(d, { searchBackends: value }),
    }),
    textField({
      id: 'fetch.jinaBaseUrl',
      label: 'Jina Reader 地址',
      block: 'network',
      effect: 'next-session',
      hint: 'web_fetch 的 JS 重页面兜底；国内可填自建反代域名',
      placeholderLabel: 'https://r.jina.ai',
      get: d => d.net.jinaBaseUrl,
      set: (d, value) => withNet(d, { jinaBaseUrl: value }),
    }),
  ]
  return { id: 'net', label: '网络与镜像', fields }
}

/**
 * Build the category/field tree for a draft.
 *
 * Depends on the draft because some field *lists* are data-driven (one row per
 * worker profile, one per routing task). v1 has no add/remove, so the row set is
 * stable across edits and cursor indices stay meaningful.
 */
export function buildCategories(draft: SettingsDraft, env: SettingsEnv): SettingsCategory[] {
  return [
    workerCategory(draft),
    reviewCategory(draft),
    visionCategory(env),
    basicsCategory(),
    netCategory(),
  ]
}

/** The slice of the draft one block owns — the unit of dirty comparison. */
export function blockValue(draft: SettingsDraft, block: SettingsBlockId): unknown {
  switch (block) {
    case 'workers': return draft.workers
    case 'review': return draft.review
    case 'vision': return draft.vision
    case 'visionAuto': return draft.visionAutoBridge
    case 'modelVision': return draft.modelVision
    case 'toolPreset': return draft.basics.toolPreset
    case 'approval': return draft.basics.approval
    case 'checkpoint': return draft.basics.checkpointEveryTurns
    case 'defaultDomain': return draft.basics.defaultDomain
    case 'defaultModel': return draft.basics.defaultModel
    case 'mirrors': return { enabled: draft.net.mirrorsEnabled, preset: draft.net.mirrorsPreset }
    case 'network': return { proxy: draft.net.proxy, noProxy: draft.net.noProxy, jinaBaseUrl: draft.net.jinaBaseUrl }
    case 'search': return draft.net.searchBackends
  }
}

const ALL_BLOCKS: readonly SettingsBlockId[] = [
  'workers', 'review', 'vision', 'visionAuto', 'modelVision', 'toolPreset', 'approval',
  'checkpoint', 'defaultDomain', 'defaultModel', 'mirrors', 'network', 'search',
]

/**
 * Blocks whose value differs from the baseline.
 *
 * Structural comparison, not change flags: editing a value and putting it back
 * leaves nothing to save, which is what "only write what changed" has to mean.
 */
export function dirtyBlocks(baseline: SettingsDraft, draft: SettingsDraft): SettingsBlockId[] {
  return ALL_BLOCKS.filter(
    block => JSON.stringify(blockValue(baseline, block)) !== JSON.stringify(blockValue(draft, block)),
  )
}
