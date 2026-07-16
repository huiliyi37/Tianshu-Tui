/**
 * 证据门（证）— CVM 阳面前提层（T1）
 *
 * 证 = agent 在产出关于系统/代码状态的结论之前，亲手碰过实物证据。
 *
 * 检测的是"探针→结果→决策"闭环——横跨多 turn 的 process-based gating。
 * 证活跃时，仁义礼智信自动升权（更可能实效）；证完成后仁自动降权。
 *
 * 与 convergence-detector 同级：不是 postTool 瞬时检测，而是轨迹级模式识别。
 *
 * @module evidence-gate
 */

/** 探针工具集 — 读取类、验证类工具，获取实物证据 */
const PROBE_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'list_dir',
  'ls',
  'search',
  'semantic_search',
  'run_tests',
])

/** 决策/写入工具集 — 产出断言或修改状态的工具 */
const DECISION_TOOLS = new Set([
  'edit_file',
  'write_file',
  'deliver_task',
])

/** bash 命令中视为探针的子串，三类：
 *  1. dry-run / typecheck / test 类（验证型执行）
 *  2. 微探针执行：`tsx -e` / `node -e`（15 秒行为实测脚本）
 *  3. 取证型只读 bash：`grep -c/-n/-o`、`wc -l`、`head -n`——"读内部实现"的
 *     bash 形态。常出现在管道尾部（`git stash list | grep foo`），整条命令
 *     仍是只读，归类探针是正确语义；词边界防误伤（`\bwc\b` 而非裸 wc）。 */
const BASH_PROBE_RE = /\b(dry[- ]run|typecheck|tsc\b|test|vitest|jest|pytest|mocha|tsx\s+--test)|(?:\b(?:npx\s+)?(?:tsx|node)\s+(?:--?\S+\s+)*-e\b)|(?:\bgrep\s+(?:--?\S+\s+)*-[a-zA-Z]*[cno]\b)|(?:\bwc\s+-[a-zA-Z]*l\b)|(?:\bhead\s+-(?:n\b|c\b|\d))/i

/** 判断 bash 命令是否为探针（而非写入） */
function isBashProbe(command: string | undefined): boolean {
  if (!command) return false
  return BASH_PROBE_RE.test(command)
}

/** 历史工具条目（轻量版，与 recentToolHistory 的 pick 子集兼容） */
export interface ToolHistoryEntry {
  tool: string
  target?: string
  turn: number
  /** bash 命令文本（仅 bash 工具有），用于探针判定 */
  command?: string
}

/** 证据检测结果 */
export interface EvidenceGateResult {
  /** 证是否活跃：score ≥ threshold（默认 0.5） */
  active: boolean
  /** 近 N 轮内闭环数 */
  closures: number
  /** 证得分 = 闭环数 / max(1, 决策工具总数)。越高代表越多决策有证据背书 */
  score: number
}

export interface DetectEvidenceGateOptions {
  recentHistory: ToolHistoryEntry[]
  currentTurn: number
  /** 回溯窗口（turn 数），默认 6 */
  windowTurns?: number
  /** 证活跃阈值，默认 0.5 */
  threshold?: number
}

/**
 * 检测证据门状态——近 N 轮内是否存在"探针→决策"闭环。
 *
 * @deprecated 分类语义正在迁移到 evidence-obligation reducer（证据驱动推理
 * 闭环计划）。本 API 保留兼容：virtue-settlement-hook（美德结算）与
 * advisory-readback（ToolHistoryEntry 类型）是活的生产消费方，待其迁移完毕
 * 后再删除。新代码请消费 `evidence-obligation.ts` 的 ObligationStore；
 * 探针/决策分类请用本模块导出的 `classifyEvidenceTool`（单一分类事实源）。
 *
 * 判据：
 *   1. 窗口内存在时序对：(探针工具 turn A, 决策工具 turn B)，A < B ≤ A + windowTurns
 *   2. target 匹配：探针和决策的 target 相同（跨 target 不计），或 run_tests 特殊处理
 *      （测试输出的消费体现在对源文件的后续修改，target 不必精确匹配）
 *   3. 空 target 降级：不计入闭环，也不计入分母（不惩罚）
 *
 * run_tests 的特殊处理：run_tests 的 target 通常是测试文件路径，后续 edit 的 target
 * 是源文件——两者 target 不同但语义上是"测试输出被消费"。对 run_tests 探针，将其
 * target 的基础名提取（去 .test.ts 后缀）与后续写入的 target 做前缀匹配。
 */
export function detectEvidenceGate(options: DetectEvidenceGateOptions): EvidenceGateResult {
  const { recentHistory, currentTurn } = options
  const windowTurns = options.windowTurns ?? 6
  const threshold = options.threshold ?? 0.5

  // 不用绝对回溯窗口过滤——窗口语义是"探针→决策之间的 turn 差 ≤ windowTurns"。
  // 取整个历史做分类，在配对时检查相对间隔。
  if (recentHistory.length === 0) {
    return { active: false, closures: 0, score: 0 }
  }

  // 分类：探针 / 决策
  const probes: ToolHistoryEntry[] = []
  const decisions: ToolHistoryEntry[] = []

  for (const h of recentHistory) {
    if (isProbe(h)) {
      probes.push(h)
    } else if (isDecision(h)) {
      decisions.push(h)
    }
  }

  // 统计闭环：探针 → 决策，target 关联 + turn 差 ≤ windowTurns
  let closures = 0
  for (const probe of probes) {
    if (!probe.target) continue
    const probeBase = extractBaseName(probe)

    for (const decision of decisions) {
      if (decision.turn <= probe.turn) continue // 决策必须在探针之后
      if (decision.turn - probe.turn > windowTurns) continue // 间隔超过窗口
      if (!decision.target) continue

      if (targetMatches(probe, decision, probeBase)) {
        closures++
        break // 一个探针最多贡献一次闭环（防一对多膨胀）
      }
    }
  }

  // 分母 = 有 target 的决策工具总数（空 target 不计入，不惩罚）
  const decisionsWithTarget = decisions.filter(d => d.target).length
  const score = decisionsWithTarget > 0
    ? closures / decisionsWithTarget
    : closures > 0
      ? 1.0 // 有闭环但分母为 0（所有决策都无 target）→ 给满分，不惩罚
      : 0

  return {
    active: score >= threshold,
    closures,
    score,
  }
}

/** 判断条目是否为探针工具 */
function isProbe(h: ToolHistoryEntry): boolean {
  if (PROBE_TOOLS.has(h.tool)) return true
  if (h.tool === 'bash') return isBashProbe(h.command ?? h.target)
  return false
}

/** 判断条目是否为决策/写入工具 */
function isDecision(h: ToolHistoryEntry): boolean {
  return DECISION_TOOLS.has(h.tool)
}

/** 探针/决策分类的单一事实源——evidence-obligation reducer 与后续消费方
 *  统一走这里，不各自维护工具集合。返回 null 表示中性工具（不参与证据闭环）。 */
export function classifyEvidenceTool(entry: Pick<ToolHistoryEntry, 'tool' | 'target' | 'command'>): 'probe' | 'decision' | null {
  if (PROBE_TOOLS.has(entry.tool)) return 'probe'
  if (entry.tool === 'bash' && isBashProbe(entry.command ?? entry.target)) return 'probe'
  if (DECISION_TOOLS.has(entry.tool)) return 'decision'
  return null
}

/** 从 run_tests 等探针中提取源文件基础名（去 .test.ts/.spec.ts 后缀） */
function extractBaseName(probe: ToolHistoryEntry): string {
  if (!probe.target) return ''
  if (probe.tool === 'run_tests') {
    // src/foo.test.ts → src/foo ; tests/bar.test.ts → src/bar (approximate)
    return probe.target
      .replace(/\.test\.(ts|tsx|js|jsx)$/, '')
      .replace(/\.spec\.(ts|tsx|js|jsx)$/, '')
      .replace(/^tests?\//, 'src/')
  }
  return probe.target
}

/** 判断探针和决策的 target 是否关联 */
function targetMatches(probe: ToolHistoryEntry, decision: ToolHistoryEntry, probeBase: string): boolean {
  if (!probe.target || !decision.target) return false

  // run_tests 特殊处理：测试文件的 base name 与源文件匹配
  if (probe.tool === 'run_tests') {
    // 源文件路径以 probeBase 开头，或 probeBase 以源文件路径开头
    return decision.target.startsWith(probeBase) || probeBase.startsWith(stripExtension(decision.target))
  }

  // bash 探针：bash typecheck 的 target 是命令文本，不与文件 target 匹配——
  // 但语义上 typecheck 通过后修改任何文件都算"测试输出被消费"
  if (probe.tool === 'bash') {
    return true // 宽松匹配：bash 探针后任何决策都算闭环
  }

  // 其余探针：精确 target 匹配
  return probe.target === decision.target
}

/** 去掉文件扩展名 */
function stripExtension(path: string): string {
  return path.replace(/\.(ts|tsx|js|jsx|json|md)$/, '')
}
