/**
 * 计划技能门禁 — 计划点名的流程 skill 必须先加载再执行（2026-07-25）。
 *
 * 事故形态（长庚域复盘）：计划正文明确写了「使用 executing-plans 逐任务实现」，
 * 执行方却以「前缀通用纪律已覆盖同类要求」为由跳过 skill 加载，自行批量执行 +
 * 自标"待验证"——流程契约被去重本能合理化掉。通用底线 ≠ 专属契约：计划点名的
 * skill 是该计划的排他工作流约定，与前缀纪律重叠不构成跳过理由。
 *
 * 语义（同 wave-gate 的机械可验证闸门哲学）：
 * - 提取：从计划文本抽取 skill 引用——显式 `skill(name=…)` 调用形状 + 指令式
 *   提及（使用/遵循/加载 + 连字符命名）。连字符是 skill 命名惯例（工具名用下划
 *   线），用作与普通词汇的区分器。
 * - 记录：会话级 module store 记录本会话实际加载过的 skill（loop-factory 的
 *   onSkillInvoked 落点），与 wave-gate 同款 sessionId 键控。
 * - 判定：点名且本运行时**可加载**但未加载 → missing（硬拦对象）；点名但运行时
 *   没有这个 skill → unavailable（留痕不拦——不能要求加载不存在的东西，计划可能
 *   写于别的技能环境）。
 * - 逃生阀：RIVET_SKILL_GATE=0 整体禁用。
 */

import { RETIRED_BUNDLED_SKILLS } from '../skills/skill-loader.js'

/** 显式工具调用形状：skill(name="executing-plans") / skill(name=executing-plans) */
const SKILL_CALL_RE = /skill\(\s*name\s*=\s*["'「]?([A-Za-z][\w-]*)/g

/** 指令式提及：使用/调用/加载/遵循/按照/follow/use/load + 连字符命名。
 *  要求名称至少含一个连字符——skill 命名惯例（executing-plans、writing-plans），
 *  排除 "use grep" 这类普通指令；工具名走下划线不会误中。 */
const DIRECTIVE_RE = /(?:使用|调用|加载|遵循|按照|执行|follow(?:ing)?|use|using|load)\s*[`「"']?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)[`」"']?/gi

/** 反引号名 + skill/技能 后缀：「`executing-plans` skill 要求…」 */
const SUFFIX_RE = /[`「]([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)[`」]\s*(?:skill|技能)/gi

/** 从计划文本提取被点名的 skill 名（大小写不敏感去重，保留首次出现的写法）。 */
export function extractRequiredSkills(planContent: string): string[] {
  const seen = new Map<string, string>()
  for (const re of [SKILL_CALL_RE, DIRECTIVE_RE, SUFFIX_RE]) {
    re.lastIndex = 0
    for (const m of planContent.matchAll(re)) {
      const name = m[1]!
      const key = name.toLowerCase()
      if (!seen.has(key)) seen.set(key, name)
    }
  }
  return [...seen.values()]
}

// ── 会话级已加载 skill 记录（同 wave-gate 的 sessionId 键控 module store）──

const invokedBySession = new Map<string, Set<string>>()

function key(sessionId?: string): string {
  return sessionId ?? '__default__'
}

export function recordSkillInvoked(name: string, sessionId?: string): void {
  const k = key(sessionId)
  let set = invokedBySession.get(k)
  if (!set) {
    set = new Set()
    invokedBySession.set(k, set)
  }
  set.add(name.toLowerCase())
}

export function getInvokedSkills(sessionId?: string): ReadonlySet<string> {
  return invokedBySession.get(key(sessionId)) ?? new Set()
}

/** 测试卫生/会话收尾清理。 */
export function clearSkillGate(sessionId?: string): void {
  invokedBySession.delete(key(sessionId))
}

export function isSkillGateEnabled(): boolean {
  return process.env.RIVET_SKILL_GATE !== '0'
}

// ── 门禁判定 ──

export interface SkillGateVerdict {
  /** 点名 + 本运行时可加载 + 未加载 → 硬拦对象。 */
  missing: string[]
  /** 点名但本运行时无此 skill → 留痕不拦。 */
  unavailable: string[]
  /** 点名但已退役为原生流程（writing-plans / executing-plans）→ 不拦，
   *  执行方按原生 <plan-mode> / <plan-executing> 纪律执行。 */
  native: string[]
}

/** 纯计算判定，全部名称比较大小写不敏感。 */
export function evaluateSkillGate(
  required: string[],
  opts: { availableNames: ReadonlySet<string>; invokedNames: ReadonlySet<string> },
): SkillGateVerdict {
  const available = new Set([...opts.availableNames].map(n => n.toLowerCase()))
  const invoked = new Set([...opts.invokedNames].map(n => n.toLowerCase()))
  const retired = new Set(RETIRED_BUNDLED_SKILLS.map(e => e.name.toLowerCase()))
  const missing: string[] = []
  const unavailable: string[] = []
  const native: string[] = []
  for (const name of required) {
    const k = name.toLowerCase()
    if (retired.has(k)) {
      // Retired → native path: no skill file to load, mapped guidance handled
      // by the skill tool's retired-name mapping.
      native.push(name)
    } else if (!available.has(k)) {
      unavailable.push(name)
    } else if (!invoked.has(k)) {
      missing.push(name)
    }
  }
  return { missing, unavailable, native }
}

/** 硬拦错误文案（executePlan 抛出用）。 */
export function formatSkillGateBlock(missing: string[]): string {
  return (
    `技能门禁：计划点名了流程 skill「${missing.join('、')}」，但本会话尚未加载。\n` +
    `计划点名的 skill 是该计划专属的执行契约，正文只含通用纪律之外的增量流程。\n` +
    missing.map(n => `先执行 skill(name="${n}") 加载并遵循其流程，`).join('') +
    `再重新发起执行。逃生阀：RIVET_SKILL_GATE=0。`
  )
}
