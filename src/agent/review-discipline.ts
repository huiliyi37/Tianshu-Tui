/**
 * Review discipline primitives distilled from the 2026-06-06 Review Squadron rounds.
 *
 * This module is intentionally pure: prompt/hook/gate/router code import the same
 * discipline text and classifiers instead of duplicating policy strings.
 */

/** 三轮对抗审查（2026-06-06）验证出的四条审查纪律。 */
export const REVIEW_DISCIPLINES: readonly string[] = [
  '不可在同一上下文自我审批：修复或交付前，须经一次独立验证 pass（换 agent/换上下文），作者的自信不能顶替验证者的命令行。',
  '修复类改动提交前，spawn adversarial_verifier 拿命令+观察输出证据——不是读懂代码就盖 PASS。',
  '改了 X 必须跑覆盖 X 的既有测试，不只跑你为 X 新写的测试；审 diff 时删除行（-）与新增行同等审视，回归常长在编辑点的相邻行。',
  '“测试全过/已修复”是最高优先级的自我审查对象，fail-closed：无“实际运行的命令+观察到的关键输出”的绿声明，一律按未验证处理。',
]

/**
 * 外部 Claude Code Opus 审查经验内化出的客观审查姿态。
 *
 * 目的不是长期依赖外部模型，而是在外部辅助不在场时，让本地
 * ReviewRouter / verifier / squadron 仍能带着“别信绿灯、主动找反例、
 * 区分亲测证据与沿用声明”的视角审查主控交付。
 */
export const OBJECTIVE_REVIEW_STANCE: readonly string[] = [
  '把自己当作外部审查者：不要替实现者补意图；提交存在、测试绿、作者声称已修，都只是待验证输入。',
  '区分亲自观察的证据与沿用他人声明；未运行命令、未看到输出、未复核调用链时，必须标记为 unverified/blocked。',
  '主动构造反例：畸形输入、缺失字段、换序集合、并发交错、错误路径、删除行相邻回归。',
  '查“定义”是否接到真实边界：常量、allowlist、guard 存在不等于调用链生效；沿调用方确认。',
]

export function formatObjectiveReviewStance(): string {
  return OBJECTIVE_REVIEW_STANCE.map((directive, index) => `${index + 1}. ${directive}`).join('\n')
}

/**
 * T7 attention-gate / MeridianIndexer review lesson:
 * path and classifier fixes are only verified when caller-produced shapes,
 * normalization boundaries, and downstream consumers are all covered.
 */
export const PATH_BOUNDARY_REVIEW_STANCE: readonly string[] = [
  '任何路径/分类/过滤/索引改动都必须先确认真实调用方传入的路径形态：repo-relative、absolute inside cwd、absolute outside cwd、../ traversal、平台分隔符。不要只测私有 helper 的理想输入。',
  '分类器 verdict 不是闭环：必须追踪 producer → normalizer → classifier → consumer/write target/DB key → assertion。类型声明或 guard 存在，不等于消费端真的用了。',
  '显式目标与默认发现要分开审：默认 broad discovery 可降噪，用户/工具显式点名路径必须可达；沉默层不等于不存在、不等于 ownership/delivery 消失。',
  '安全边界按 fail-closed/fail-toward-content 区分：项目外路径不得读/索引/入库；陌生项目内内容默认当 L3 content，不用 truthy/falsy 或字符串前缀哨兵偷判。',
]

export function formatPathBoundaryReviewStance(): string {
  return PATH_BOUNDARY_REVIEW_STANCE.map((directive, index) => `${index + 1}. ${directive}`).join('\n')
}

const FIX_PATTERNS = [
  /\bfix(?:\(|:|\b)/i,
  /\bbugfix\b/i,
  /\bpatch\b/i,
  /regression/i,
  /修复/,
  /回归/,
]

export function isFixContext(message: string): boolean {
  return FIX_PATTERNS.some(pattern => pattern.test(message))
}

export type ReviewScale = 'L1' | 'L2' | 'L3'

export interface ChangeSet {
  files: readonly string[]
  crossModule: boolean
  isFix: boolean
}

const TRIVIAL_FILE_PATTERN = /(?:^|\/)(?:README|CHANGELOG)(?:\.[^/]*)?$|\.(?:md|mdx|txt|json)$/i
const DEPENDENCY_OR_COMPILER_CONFIG_PATTERN = /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock|tsconfig(?:\.[^/]*)?\.json|[^/]+\.lock)$/i

/**
 * Classify a change set into the review workflow scale:
 * - L3: new/cross-module/large changes → Review Squadron
 * - L2: fix, code, dependency, or compiler config changes → single adversarial verifier
 * - L1: tiny non-fix docs/trivial data changes → nudge only
 */
export function classifyChangeScale(change: ChangeSet): ReviewScale {
  if (change.crossModule || change.files.length >= 4) return 'L3'
  if (change.files.some(file => DEPENDENCY_OR_COMPILER_CONFIG_PATTERN.test(file))) return 'L2'
  if (!change.isFix && change.files.length > 0 && change.files.every(file => TRIVIAL_FILE_PATTERN.test(file))) {
    return 'L1'
  }
  return 'L2'
}

/** Route any non-empty delivery through ReviewRouter; L1 remains a non-blocking nudge. */
export function shouldRouteReviewWorkflow(change: ChangeSet): boolean {
  return change.files.length > 0
}

/** Default rule: files spanning at least two src/<module>/ top-level modules are cross-module. */
export function isCrossModule(files: readonly string[]): boolean {
  const modules = new Set<string>()
  for (const file of files) {
    const moduleName = file.match(/(?:^|\/)src\/([^/]+)\//)?.[1]
    if (moduleName) modules.add(moduleName)
  }
  return modules.size >= 2
}
