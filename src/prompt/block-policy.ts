import { existsSync, readFileSync } from 'node:fs'
import { findProjectConfig } from '../config/manager.js'
import { userConfigPath } from '../config/paths.js'
import { isRuntimeLeanAspect } from '../config/runtime-lean.js'

/**
 * A3 前缀预算上限（字符）。frozen 块超出后由 truncateBlock 截断。
 *
 * 住在策略层而非渲染层：它是 standard 档的定义本身，lean/full 都相对它缩放。
 * volatile.ts re-export 以兼容既有 import。数值沿用 A3 审计口径未改。
 */
export const FROZEN_BLOCK_CAPS = {
  projectInstructions: 8_000,
  projectMemory: 3_000,
  knowledgeManifest: 2_200,
  seedCapsule: 3_000,
  codebaseIndex: 4_000,
} as const

export type FrozenBlockCaps = typeof FROZEN_BLOCK_CAPS

/**
 * 子代理的 frozen 块上限覆盖。
 *
 * project-instructions 收到 4,000：按节选取（见 project-instructions.ts）在这个
 * 预算下仍能装下全部硬闸门章节与代码约定，被挤掉的是目录索引、能力全景、排查
 * 手册这类"自己找路"用的参考资料——子代理接的是自包含任务卡，不需要自己找路，
 * 真需要时它有 read_file。
 *
 * 不分只读/写工两档：分层本身已经按内容适配，再加一个按档位猜"谁需要哪节"的
 * 旋钮只增加校准负担。
 */
export const SUBAGENT_BLOCK_CAPS: Partial<Record<keyof FrozenBlockCaps, number>> = {
  projectInstructions: 4_000,
}

/**
 * 前缀块策略 — 决定 frozen 前缀里挂多少「参考类」内容。
 *
 * 解析优先级（镜像 tools/tool-preset.ts）：
 *   RIVET_PROMPT_PROFILE env > 项目 .rivet-config.json > 用户 ~/.rivet/config.json > 'standard'
 * 会话启动期解析一次并 memo；会话中途改配置不生效（改前缀 = 全量重建，反经济）。
 *
 * ## 三分法：什么能动，什么不能动
 *
 * 本策略**只作用于参考类块**——查询资料，模型不知道时会主动查，且都有
 * recall 通道兜底（recall_capsule / memory / repo_map）。
 *
 * 它**永不作用于行为护栏**：static.ts 的 rules / delivery-contract /
 * workflow / security，以及星域 volatileBlock。原因是 V3.1 的生产观测——
 * `0c776b9` 把胶囊正文撤成按需 recall，同日 `17b496a` 回滚，根因判定
 * 「护栏起作用的时刻正是 agent 没意识到自己跑偏时，它不会想到去 recall」。
 * 按需召回适合参考资料，不适合刹车。
 *
 * ## 为什么默认是 standard 而不是 lean
 *
 * 默认值改动会一次性冲掉全体用户的前缀缓存，并改变既有行为基线。static.ts
 * 上「砍了又恢复」的记录至少四次（c6b81bdf→85079568、5c3cc3f6→76d587cf、
 * 104a9b8c→d7586efc、26514a4d→7c67eefa）。因此 lean 是 opt-in：
 * 无配置时必须返回与历史版本逐字节一致的 standard。
 * 这条不变量由 __tests__/block-policy.test.ts 锁定，不要为「lean 效果不错」
 * 而改默认——那等于绕过全部防线重演 V3.1。
 */

export type PromptProfile = 'standard' | 'lean' | 'full'
export type ToolDescriptionMode = 'full' | 'compact'

/** 参考类块开关。护栏类不在此列——它们没有开关，这是有意的。 */
export interface PromptBlockToggles {
  seedCapsule: boolean
  knowledgeManifest: boolean
  codebaseIndex: boolean
  projectMemory: boolean
  historicalLessons: boolean
}

export interface PromptBlockPolicy {
  profile: PromptProfile
  toolDescriptions: ToolDescriptionMode
  blocks: PromptBlockToggles
  /** 各 frozen 块的字符上限，已按 profile 缩放。 */
  caps: Record<keyof typeof FROZEN_BLOCK_CAPS, number>
  /** seed-capsule 索引保留条数；undefined = 全挂。 */
  capsuleIndexLimit: number | undefined
}

const ALL_ON: PromptBlockToggles = {
  seedCapsule: true,
  knowledgeManifest: true,
  codebaseIndex: true,
  projectMemory: true,
  historicalLessons: true,
}

/**
 * 档位基线。standard 必须逐字段等于渲染层的硬编码默认值——它是「不改变
 * 任何字节」的契约，改这里等于改所有默认会话的前缀。
 */
const PROFILE_BASELINE: Record<PromptProfile, Omit<PromptBlockPolicy, 'profile'>> = {
  standard: {
    toolDescriptions: 'full',
    blocks: { ...ALL_ON },
    caps: { ...FROZEN_BLOCK_CAPS },
    capsuleIndexLimit: undefined,
  },
  lean: {
    toolDescriptions: 'compact',
    // historical-lessons 是 appendix 里唯一每边界重排的 churner，且内容都能
    // 经 memory recall 拿到——lean 档第一个关它。
    blocks: { ...ALL_ON, historicalLessons: false },
    caps: {
      projectInstructions: FROZEN_BLOCK_CAPS.projectInstructions,
      projectMemory: 1_500,
      knowledgeManifest: 1_000,
      seedCapsule: FROZEN_BLOCK_CAPS.seedCapsule,
      codebaseIndex: 1_500,
    },
    capsuleIndexLimit: 5,
  },
  full: {
    toolDescriptions: 'full',
    blocks: { ...ALL_ON },
    caps: {
      projectInstructions: 12_000,
      projectMemory: 5_000,
      knowledgeManifest: 4_000,
      seedCapsule: 5_000,
      codebaseIndex: 6_000,
    },
    capsuleIndexLimit: undefined,
  },
}

const VALID_PROFILES = new Set<string>(['standard', 'lean', 'full'])
const VALID_TOOL_MODES = new Set<string>(['full', 'compact'])

function parseProfile(raw: unknown): PromptProfile | null {
  return typeof raw === 'string' && VALID_PROFILES.has(raw) ? (raw as PromptProfile) : null
}

function parseToolMode(raw: unknown): ToolDescriptionMode | null {
  return typeof raw === 'string' && VALID_TOOL_MODES.has(raw) ? (raw as ToolDescriptionMode) : null
}

/** config 文件里的 prompt 节（宽松读取——这里不做 zod 校验，坏配置按缺省处理）。 */
interface RawPromptSection {
  profile?: unknown
  toolDescriptions?: unknown
  blocks?: Record<string, unknown>
}

function readPromptSection(path: string): RawPromptSection | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { prompt?: RawPromptSection }
    return raw.prompt ?? null
  } catch {
    return null // malformed config — fall through to lower priority
  }
}

function applyBlockOverrides(base: PromptBlockToggles, raw: Record<string, unknown> | undefined): PromptBlockToggles {
  if (!raw) return base
  const next = { ...base }
  for (const key of Object.keys(base) as (keyof PromptBlockToggles)[]) {
    const v = raw[key]
    if (typeof v === 'boolean') next[key] = v
  }
  return next
}

const memo = new Map<string, PromptBlockPolicy>()

export function resolvePromptBlocks(cwd: string): PromptBlockPolicy {
  const cached = memo.get(cwd)
  if (cached) return cached

  // 低优先级在前，逐层覆盖：用户配置 → 项目配置 → env。
  // 用户层走 userConfigPath()（认 RIVET_HOME / RIVET_CONFIG_PATH），而不是
  // tool-preset.ts 用的裸 defaultRivetHome()——后者在自定义数据根下读不到配置。
  const sections: RawPromptSection[] = []
  const userSection = readPromptSection(userConfigPath())
  if (userSection) sections.push(userSection)

  const projectPath = findProjectConfig(cwd)
  if (projectPath) {
    const projectSection = readPromptSection(projectPath)
    if (projectSection) sections.push(projectSection)
  }

  let profile: PromptProfile | null = null
  let toolDescriptions: ToolDescriptionMode | null = null
  let blockOverrides: Record<string, unknown> = {}
  for (const section of sections) {
    profile = parseProfile(section.profile) ?? profile
    toolDescriptions = parseToolMode(section.toolDescriptions) ?? toolDescriptions
    if (section.blocks) blockOverrides = { ...blockOverrides, ...section.blocks }
  }

  // env 最高优先级
  profile = parseProfile(process.env.RIVET_PROMPT_PROFILE) ?? profile
  toolDescriptions = parseToolMode(process.env.RIVET_PROMPT_TOOL_DESC) ?? toolDescriptions

  const resolved = profile ?? (isRuntimeLeanAspect('prompt', undefined, cwd) ? 'lean' : 'standard')
  const baseline = PROFILE_BASELINE[resolved]

  const policy: PromptBlockPolicy = {
    profile: resolved,
    // 显式 toolDescriptions 覆盖 profile 的默认（lean 也能要 full 描述）
    toolDescriptions: toolDescriptions ?? baseline.toolDescriptions,
    blocks: applyBlockOverrides(baseline.blocks, blockOverrides),
    caps: { ...baseline.caps },
    capsuleIndexLimit: baseline.capsuleIndexLimit,
  }

  memo.set(cwd, policy)
  return policy
}

/** 丢弃 memo（设置变更 / 长驻进程如桌面 sidecar / 测试）。 */
export function invalidatePromptBlocks(): void {
  memo.clear()
}

/** 不读配置的 standard 策略——供不关心档位的调用方使用。 */
export function standardPromptBlocks(): PromptBlockPolicy {
  return { profile: 'standard', ...PROFILE_BASELINE.standard, caps: { ...PROFILE_BASELINE.standard.caps }, blocks: { ...ALL_ON } }
}

/**
 * 子代理策略：standard 叠加 {@link SUBAGENT_BLOCK_CAPS}，描述档位走 compact。
 *
 * compact 对内置工具是 no-op（最长描述 480 字符，够不着 800 的压缩门槛），
 * 只在 worker 注册表含 MCP 工具时省字节。之所以仍然显式设定，是因为不设就等于
 * 让 worker 隐式落在 full——同一份注册表在主控 lean 档下是 compact，在 worker
 * 下是 full，无谓的不一致。
 *
 * 构造期（staticCtx.tools）与 `updateTools()`（loop 的 blockPolicy）必须读同一份，
 * 否则 MCP 异步注册后描述回弹成 full → system 字节中途翻转 → 整段前缀缓存 miss。
 */
export function subagentPromptBlocks(): PromptBlockPolicy {
  return {
    ...standardPromptBlocks(),
    toolDescriptions: 'compact',
    caps: { ...PROFILE_BASELINE.standard.caps, ...SUBAGENT_BLOCK_CAPS },
  }
}
