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
 * 通用开发方法论 — L1（最轻量 / 默认 nudge）层面对每次交付都适用的工程纪律。
 *
 * 与 OBJECTIVE/WIRING 等对抗审查 stance 不同：这里不绑定本项目实现，面向开源用户的
 * 任意代码库；当一次交付只命中 L1（nudge）时随交付报告提示，作为通用提醒而非阻断门。
 *
 * 沉淀来源：把「一次性 / 瞬时值」塞进有「未更新即沿用」语义的累积通道导致黏滞的缺陷
 * （本仓库 appendixDelta 的 ephemeral hint 黏滞是其一个实例，此处抽象为通用原则）。
 * 与瑶光「复现即证」属同一方法星域的累积——根都是「未核实语义就复用」。
 */
export const GENERAL_DEV_DISCIPLINES: readonly string[] = [
  '累积通道只接幂等的状态派生值：当一个通道带有「未显式更新就沿用上一次值」的语义（缓存、增量/delta 同步、diff 编码、记忆化 memo、脏标记渲染、快照复用、last-write-wins 合并、增量索引），它只能承载可由当前状态确定性重算的幂等值。一次性/瞬时值（提示、告警、本轮事件、只应展示一次的内容）放进去会黏滞——消费端会把「这次没出现」解读为「沿用上次」而非「已消失」。改动任何带状态复用语义的通道前先问：值消失时消费端会当它「清空」还是「沿用」？瞬时值应走每次显式重发 / 显式清除的通道，或为累积通道配 tombstone（显式失效标记）。',
]

export function formatGeneralDevDisciplines(): string {
  return GENERAL_DEV_DISCIPLINES.map((directive, index) => `${index + 1}. ${directive}`).join('\n')
}

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
  // 沉淀自一次 objective-dedup 守卫缺陷（!!projection 当成「含 objective」用，投影因一次性提示非空时误删目标）。
  // 与瑶光「绿非证明」同源——都是「未核实语义等价就复用一个弱信号」。
  '代理真值漂移：守卫/分支用「X 存在 / 非空 / 非零 / truthy」代理「X 满足某更强的内容谓词（含某字段、等于某值、处于某状态）」时，要么证明二者在所有真实数据形态下等价，要么构造「弱代理为真、强谓词为假」的反例。典型反模式：`if (obj)` 当成 `if (obj.hasFoo)`、`!list.length` 当成「无有效项」、`!!str` 当成「含目标标记」。审 diff 时对每个新增/改动的布尔守卫追问：这个条件真的等于它所守卫的语义吗？',
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

/**
 * 天权（称量者）审查之道里不与对抗验证重复的那一维：审查不只验真伪、找反例，
 * 还要"称量"——权衡这个改动在当前上下文里偏轻还是偏重、退化了什么换来了什么。
 * 对抗验证回答"对不对"，称量回答"值不值、是否伤了全局"。仅保留此独有维度，
 * 同伴归零/沉默是失职等已由 REVIEW_DISCIPLINES / OBJECTIVE_REVIEW_STANCE 覆盖。
 */
export const WEIGHING_REVIEW_STANCE: readonly string[] = [
  '审查不止于找错，更要称量：这个改动在当前上下文里偏轻还是偏重？封装/抽象/边界退化了多少，换来了什么？秤的两端都要放上东西，只报缺陷不报代价是半截称量。',
  '记账全局影响：局部优化是否以牺牲整体稳定/封装性为代价（如批量移除 private、复制常量、跨模块耦合）。真实退化即使"测试仍绿"也要记录并指明偿还阶段，不可静默通过。',
]

export function formatWeighingReviewStance(): string {
  return WEIGHING_REVIEW_STANCE.map((directive, index) => `${index + 1}. ${directive}`).join('\n')
}

/**
 * 接线生效审查姿态（2026-06-12 噪音治理/委派质量复审教训）：
 * 「功能建好」≠「接好」≠「生效」。专抓建好但断线、半做、或实际效果与声称
 * 目标相反的改动。对抗验证回答"对不对"，称量回答"值不值"，本姿态回答
 * "通没通、灵不灵"——一次复审抓出双渲染增噪、门控静默全关、死参数无人传
 * 三类问题，全部带着绿测试通过了交付。
 */
export const WIRING_EFFECTIVENESS_REVIEW_STANCE: readonly string[] = [
  '闭环必须从生产入口正向追：先识别目标项目的真实运行入口（package.json 的 bin/main/start 脚本、服务启动文件、CLI 入口、框架约定入口如 next/vite/django 的 app 根），再从入口经组合根（bootstrap/composition root/DI 容器/路由注册）逐跳追到改动点，确认它在该路径上被构造/传参/调用。"在某处找到了挂点"不是闭环证据——只出现在废弃/平行入口、示例代码、脚本或测试里的挂点不算；多入口项目（CLI+server、新旧 UI 并存）必须确认挂点位于本次改动实际影响的那条入口链上。找不到从活入口到改动点的正向链路时按 HIGH 上报断线。',
  '逐条对照计划/提交声明的验收标准审"做没做完"，不以"提交存在、代码在场、测试绿"为完成；专找半做：字段加了但无消费端执行、能力建了但生产路径不调用、预算换了来源但仍然无人检查。',
  '新能力沿 生产者→传输→消费者→渲染/执行 全链路走通才算接好：新增可选参数必须 grep 全部调用方，零调用方传值即死参数；新增 setter/store/bus 必须确认存在 flush/失效/读取路径，否则是死 setter；新增 config 字段必须确认运行时真的读取。',
  '目标反效检查：改动声称减少 X（噪音/重复/成本/延迟），就构造场景验证 X 实际下降。旧通道未删、新通道又渲染同一内容的"双渲染"是典型反效——减噪提交反而增噪，按 HIGH 上报。',
  '门控/过滤条件用运行时真实数据形态核对，不信类型签名：相对 vs 绝对路径、可选字段缺失、空集合、模型自由输入。估算真实通过率——过滤掉 ~100% 的门控等于静默关闭功能，与放行 100% 同等严重。',
  '对结构化内容（XML/JSON/markdown 块）的截断或 slice，验证不变式保持：闭合标签、转义、配对符号不被切断；并确认截断结果是确定性的，不引入前缀缓存抖动。',
]

export function formatWiringEffectivenessReviewStance(): string {
  return WIRING_EFFECTIVENESS_REVIEW_STANCE.map((directive, index) => `${index + 1}. ${directive}`).join('\n')
}

/**
 * 方法论文档验证姿态（2026-06-14 PlanDesignIntentRouter 对抗审查反推）：
 * 方法论文档（知识文件、计划模板、规则、自检清单）包含可执行指令——
 * grep 命令、正则表达式、心智操作步骤。这些与代码函数实现具有相同的性质：
 * 可执行、可验证、可能出错。"写完一条 grep 示例而不跑它" = "写完一个函数
 * 而不跑它的测试"。本姿态专抓方法论文档中的隐蔽缺陷——它们不会报测试红，
 * 但会在执行者遵循时静默失效。
 *
 * 三条核心教训：
 *  1. 方法论文档是代码——grep/regex/命令必须经实证验证
 *  2. "数门"和"数调用者"是两件事——沿操作往下数门，而非沿函数往上数调用者
 *  3. 递归自验证——方法论能在自己的规则里发现错误并修正 = 活系统
 */
export const METHODOLOGY_VERIFICATION_STANCE: readonly string[] = [
  '方法论文档中的每一条可执行指令（grep、regex、shell 命令、心智操作步骤）必须在真实代码库中跑一遍并确认输出覆盖预期目标，然后才能提交。不跑不交付。理由：补丁里写的那条 grep "validatePathSafe" 在写作模式下"看起来对"，但实证验证发现它漏掉了 sandbox-profile.ts——因为两个门的关系不是 caller/callee，而是并行执行点共享状态模块。',
  '核实"门"之间的关系是 caller/callee 还是并行执行点：不要假设两个 enforcement point 共享 guard 函数。grep 共享状态的导入方（rg -l "state-module" src/），或枚举"这个操作的所有拒绝点"——沿着操作往下数门，而非沿着函数往上数调用者。原则 A 的原始措辞用"guard 函数"隐喻把并行执行点压缩成了调用链，遮蔽了真实架构。',
  '修复方法论文档的补丁，用方法论自己的原则递归审查它自己：补丁是否引入了与原始缺陷同族的错误？补丁中的可执行指令是否经实证验证？方法论能抓住自己的错误 = 活的系统；补丁写了就冻结从不回头验证 = 死的文档。',
]

export function formatMethodologyVerificationStance(): string {
  return METHODOLOGY_VERIFICATION_STANCE.map((directive, index) => `${index + 1}. ${directive}`).join('\n')
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

import type { ChangeClassification } from './change-classification.js'

export type ReviewScale = 'L1' | 'L2' | 'L3'

export interface ChangeSet {
  files: readonly string[]
  crossModule: boolean
  isFix: boolean
  /** Explicitly override the auto-classified review scale. L2 = single verifier, L3 = squadron. */
  forceLevel?: ReviewScale
  /** User-provided focus hint (from /review [max] <focus>). Passed to
   *  inspector/verifier objectives so workers know what to prioritize. */
  focusHint?: string
  /** When true, review is suppressed to L1 (nudge-only) regardless of change
   *  structure. Set by deliver_task when a goal tracker is actively driving
   *  auto-continuation — child review workers would stall the goal loop. */
  goalActive?: boolean
  /** Mechanical-change classification from deliver_task. When present with
   *  skipReview=true, auto review skips workers (nudge only). */
  changeClass?: ChangeClassification
  /** Files whose size exceeds {@link LARGE_FILE_WARN_THRESHOLD}. Review workers
   *  use this to avoid reading entire large files (use offset/limit instead).
   *  Set by deliver_task before spawning review; absent in test / slash-review paths. */
  largeFiles?: ReadonlyArray<{ path: string; sizeBytes: number }>
}

/** File size (bytes) above which review workers receive a "use offset/limit, do not
 *  read whole file" advisory.  200 KB catches the 501 KB agent-session.ts class
 *  without false-positive on typical source files (most are 10-80 KB). */
export const LARGE_FILE_WARN_THRESHOLD = 200_000

const TRIVIAL_FILE_PATTERN = /(?:^|\/)README|CHANGELOG(?:\.[^/]*)?$|\.(?:md|mdx|txt|json)$/i
const DEPENDENCY_OR_COMPILER_CONFIG_PATTERN = /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock|tsconfig(?:\.[^/]*)?\.json|[^/]+\.lock)$/i
const TEST_ONLY_PATTERN = /(?:^|\/)__tests__\//i

/** Files touching these paths cross into security/safety boundaries → forced L3. */
const SECURITY_BOUNDARY_PATTERNS = [
  'approval-risk',
  'path-validate',
  'sandbox-exec',
  'permissions',
  'sycophancy-trap',
  'immune-hook',
  'sensitive-preflight',
]

function isTestOnlyFile(file: string): boolean {
  return TEST_ONLY_PATTERN.test(file)
}

/** Docs/test-only change — auto review adds no value here, nudge suffices. */
export function isTrivialChange(files: readonly string[]): boolean {
  return files.length > 0 && files.every(file =>
    TRIVIAL_FILE_PATTERN.test(file) || isTestOnlyFile(file)
  )
}

function touchesSecurityBoundary(files: readonly string[]): boolean {
  return files.some(f => SECURITY_BOUNDARY_PATTERNS.some(p => f.includes(p)))
}

/**
 * Classify a change set into the review workflow scale:
 * - L3: cross-module, large (≥5 files), or touches security boundary → Review Squadron
 * - L2: dependency/config files → single adversarial verifier (opt-in by file nature)
 * - L1: everything else → nudge only (DEFAULT — no child workers spawned)
 *
 * isFix from the commit message is NOT used as a gating signal —
 * structural properties of the change determine review depth, not message prefix.
 */
export function classifyChangeScale(change: ChangeSet): ReviewScale {
  if (change.forceLevel) return change.forceLevel
  // Goal-active mode: suppress auto-review to L1 so child review workers
  // don't stall the goal auto-continuation loop. L3 is reserved for the
  // final goal-achieved commit (triggered manually or via deactivation hook).
  if (change.goalActive) return 'L1'
  if (change.crossModule || change.files.length >= 5 || touchesSecurityBoundary(change.files)) return 'L3'
  if (change.files.some(file => DEPENDENCY_OR_COMPILER_CONFIG_PATTERN.test(file))) return 'L2'
  if (change.files.length > 0 && change.files.every(file =>
    TRIVIAL_FILE_PATTERN.test(file) || isTestOnlyFile(file)
  )) {
    return 'L1'
  }
  // DEFAULT: L1 — nudge only. L2/L3 require explicit structural signals
  // (cross-module, large batch, security boundary, dep/config files).
  // This prevents review workflow child workers from stalling deliver_task.
  return 'L1'
}

/**
 * Upgrade review scale based on task dependency depth.
 * wiring tasks need at least L2 (adversarial verifier),
 * system tasks need L3 (review squadron).
 */
export function upgradeScaleByDepth(base: ReviewScale, depthLayer?: import('../context/task-contract.js').TaskDepthLayer): ReviewScale {
  if (!depthLayer || depthLayer === 'unit') return base
  if (depthLayer === 'system') return 'L3'
  if (depthLayer === 'wiring' && base === 'L1') return 'L2'
  return base
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
