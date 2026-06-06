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
