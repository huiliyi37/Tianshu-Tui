/**
 * Plan Execution Trace — 计划执行轨迹 (U1)
 *
 * 将 agent 从"单步执行器"升级为"自主规划者"：
 * - planning 阶段：目标分解为结构化 PlanStep[]
 * - executing 阶段：每步追加 StepResult（状态 + 产出 + 偏差）
 * - 压缩时：serializeTrace() 注入动态附录（同 task-anchor 模式，prefix-cache 安全）
 *
 * 纯函数模块——无类、无副作用、不可变更新。loop.ts 通过接口消费。
 */

import type { TaskDepthLayer } from '../context/task-contract.js'
import type { PlanStepInput } from '../tools/types.js'

// ─── Types ─────────────────────────────────────────────────────

export type TraceStatus = 'active' | 'replanned' | 'completed' | 'blocked'
export type StepStatus = 'pending' | 'active' | 'done' | 'skip' | 'replanned'
export type ResultStatus = 'done' | 'deviated' | 'replanned' | 'blocked'

export interface PlanStep {
  id: string                  // "step-1"
  description: string         // "读取 plan-mode.ts 理解现状"
  expectedTools: string[]     // ["read_file", "grep"]
  verificationHint?: string   // "确认 PlanModeState 是二态布尔开关"
  status: StepStatus
}

export interface ToolCallSummary {
  tool: string
  result_summary: string
}

export interface StepResult {
  stepId: string
  turnNumber: number
  toolCalls: ToolCallSummary[]
  status: ResultStatus
  /** 新发现的文件（stray 探索时标注，偏差检测排除这些文件） */
  newFiles?: string[]
  /** 偏差时标注原因 */
  replanNote?: string
}

export interface PlanExecutionTrace {
  contractId: string
  steps: PlanStep[]
  history: StepResult[]
  status: TraceStatus
  /** 关联的深度分类，控制步数上限 */
  depthLayer: TaskDepthLayer
  /** 上一次序列化的缓存（避免重复计算） */
  _serializedAtStep?: number
}

export type DeviationType = 'blocked' | 'deviated' | 'replanned' | 'stray' | 'stalled' | 'none'

export interface DeviationResult {
  type: DeviationType
  reason: string
  /** 受影响的 stepId */
  affectedStepId?: string
}

// ─── Constants ─────────────────────────────────────────────────

/** 深度分类 → 步数上限 */
const MAX_STEPS_BY_DEPTH: Record<TaskDepthLayer, number> = {
  unit: 3,
  wiring: 5,
  system: 8,
}

/** blocked 检测：连续相同工具失败次数 */
const BLOCKED_FAILURE_THRESHOLD = 3
/** stalled 检测：无工具回合数 */
const STALLED_NO_TOOL_TURNS = 3

/** U3: 触发 LSP 工具自动注入的关键词 */
const LSP_TRIGGER_KEYWORDS = ['理解', '追踪', '调用方', '依赖', '消费', '引用', '影响', '调用链', '结构']
const LSP_EXPAND_TOOLS = ['lsp_find_references', 'lsp_goto_definition']

// ─── Pure Functions ────────────────────────────────────────────

/**
 * U3: 根据步骤描述推断 expectedTools。
 * 描述包含"理解/追踪/调用方/依赖"等关键词时自动追加 LSP 工具。
 */
export function inferExpectedTools(description: string, baseTools: string[] = ['read_file']): string[] {
  const tools = [...baseTools]
  const lowerDesc = description.toLowerCase()
  const hasLspTrigger = LSP_TRIGGER_KEYWORDS.some(kw => description.includes(kw) || lowerDesc.includes(kw))
  if (hasLspTrigger) {
    for (const t of LSP_EXPAND_TOOLS) {
      if (!tools.includes(t)) tools.push(t)
    }
  }
  return tools
}


/**
 * 创建一个新的执行轨迹。steps 由调用方填充（来自 planning 阶段的目标分解）。
 */
export function createTrace(
  contractId: string,
  depthLayer: TaskDepthLayer,
  steps?: PlanStep[],
): PlanExecutionTrace {
  return {
    contractId,
    steps: steps ?? [],
    history: [],
    status: 'active',
    depthLayer,
  }
}

/**
 * 获取深度分类对应的步数上限。
 */
export function maxStepsForDepth(depth: TaskDepthLayer): number {
  return MAX_STEPS_BY_DEPTH[depth]
}

function mapTodoStatusToStepStatus(status: PlanStepInput['status']): StepStatus {
  switch (status) {
    case 'in_progress': return 'active'
    case 'completed': return 'done'
    default: return 'pending'
  }
}

/** 向后兼容：字符串描述等价于 `{ content: ... }`。 */
type PlanStepLike = PlanStepInput | string

function normalizePlanStepInputs(steps: PlanStepLike[]): PlanStepInput[] {
  // String inputs carry no id — leave it undefined so numbering happens AFTER
  // blank filtering in buildPlanSteps (otherwise a leading blank consumes step-1
  // and the first real step ends up as step-2).
  return steps.map(s => (typeof s === 'string' ? { content: s } : s))
}

/**
 * U6/C1: 把 planning 阶段产出的步骤输入映射成结构化 PlanStep[]。
 * 模型只需给出描述，expectedTools 由 inferExpectedTools 自动推断（含 LSP 关键词）。
 * 步数按 depthLayer 截断（unit=3 / wiring=5 / system=8），空白描述被过滤。
 */
export function buildPlanSteps(
  steps: PlanStepLike[],
  depthLayer: TaskDepthLayer,
): PlanStep[] {
  const max = MAX_STEPS_BY_DEPTH[depthLayer]
  return normalizePlanStepInputs(steps)
    .filter(s => s.content.trim().length > 0)
    .slice(0, max)
    .map((s, i) => ({
      id: s.id ?? `step-${i + 1}`,
      description: s.content.trim(),
      expectedTools: inferExpectedTools(s.content),
      status: mapTodoStatusToStepStatus(s.status),
    }))
}

/**
 * U6/C1: 把分解出的步骤填入 trace；若 trace 已有步骤，则按 id/description
 * 同步状态。这样 todo write / plan_task 都能持续刷新 PlanExecutionTrace。
 */
export function withPlanSteps(
  trace: PlanExecutionTrace,
  steps: PlanStep[],
): PlanExecutionTrace {
  // 幂等守卫：一旦执行已开始（有 history），绝不回填/重写计划步骤——中途重规划
  // 会破坏 trace 稳定性。返回同一引用，下游可用引用相等判断"无变更"。
  if (trace.history.length > 0) return trace
  // 全新 trace（无步骤、无 history）：填入初始步骤。
  if (trace.steps.length === 0) return { ...trace, steps }

  // 已有步骤（无 history）：只同步状态，不覆盖结构。无任何变更时返回同一引用。
  let changed = false
  const merged = trace.steps.map(existing => {
    const match = steps.find(s =>
      (s.id && s.id === existing.id) || s.description === existing.description
    )
    if (!match) return existing
    // 不覆盖已经 done/replanned 的状态为 pending/active
    if (existing.status === 'done' || existing.status === 'replanned') return existing
    if (existing.status === match.status) return existing
    changed = true
    return { ...existing, status: match.status }
  })
  return changed ? { ...trace, steps: merged } : trace
}

/**
 * 追加一个步骤结果。不可变更新——返回新 trace。
 * 同时推进对应 step 的状态。
 */
export function appendResult(
  trace: PlanExecutionTrace,
  result: StepResult,
): PlanExecutionTrace {
  const steps = trace.steps.map(step => {
    if (step.id === result.stepId) {
      return {
        ...step,
        status: mapResultToStepStatus(result.status, step.status) as PlanStep['status'],
      }
    }
    return step
  })

  return {
    ...trace,
    steps,
    history: [...trace.history, result],
    status: result.status === 'blocked' ? 'blocked' : trace.status,
  }
}

function mapResultToStepStatus(
  resultStatus: ResultStatus,
  current: StepStatus,
): StepStatus {
  switch (resultStatus) {
    case 'done': return 'done'
    case 'deviated': return 'replanned'
    case 'replanned': return 'replanned'
    case 'blocked': return current === 'done' ? 'done' : 'pending'
  }
}

/**
 * 检测偏差类型。优先级降序：
 * 1. blocked — 连续 N 步相同工具失败
 * 2. stalled — 无工具回合数 >= 阈值
 * 3. deviated — toolCalls 不在 expectedTools 范围内（排除 newFiles 发现）
 * 4. stray — 执行了不在任何 PlanStep.expectedTools 中的工具
 * 5. replanned — 所有步骤完成但 trace 未 complete
 * 6. none — 无偏差
 *
 * @param trace 当前轨迹
 * @param lastResult 最近一次步骤结果（可选，无工具回合时为 undefined）
 * @param convergenceLevel convergence-detector 的 level（可选，>=2 表示多次失败）
 * @param noToolTurnCount 连续无工具回合数（可选）
 */
export function detectDeviation(
  trace: PlanExecutionTrace,
  lastResult?: StepResult,
  convergenceLevel?: number,
  noToolTurnCount?: number,
): DeviationResult {
  // 1. blocked — convergence level >= 2 且有最近失败
  if (convergenceLevel !== undefined && convergenceLevel >= 2) {
    const recentFailing = trace.history
      .slice(-BLOCKED_FAILURE_THRESHOLD)
      .filter(r => r.status === 'blocked')
    if (recentFailing.length >= BLOCKED_FAILURE_THRESHOLD) {
      return {
        type: 'blocked',
        reason: `连续 ${recentFailing.length} 步失败，工具可能不可用或目标不可达`,
        affectedStepId: recentFailing[recentFailing.length - 1]?.stepId,
      }
    }
  }

  // 2. stalled — 无工具回合过多
  if (noToolTurnCount !== undefined && noToolTurnCount >= STALLED_NO_TOOL_TURNS) {
    return {
      type: 'stalled',
      reason: `连续 ${noToolTurnCount} 回合无工具调用，agent 可能停滞`,
    }
  }

  // replanned 检测：所有步骤标记完成 + 足够的执行证据
  // 守卫：history 覆盖率 >= steps 数量，防止 agent 在少数轮次内一口气
  // 标记所有 step done 但实际未逐步执行（step done 只代表"工具没报错"，
  // 不代表目标真完成）。见 plan-trace-coordinator.buildStepResultFromTurn。
  const allDone = trace.steps.length > 0 && trace.steps.every(
    s => s.status === 'done' || s.status === 'skip',
  )
  const historyCoversSteps = trace.history.length >= trace.steps.length
  if (allDone && historyCoversSteps && trace.status !== 'completed') {
    return {
      type: 'replanned',
      reason: '所有计划步骤已逐步执行完成，trace 可标记为 completed',
    }
  }

  if (!lastResult) return { type: 'none', reason: '' }

  // 3. deviated — toolCalls 不在 expectedTools 范围（排除 newFiles）
  const step = trace.steps.find(s => s.id === lastResult.stepId)
  if (step && step.expectedTools.length > 0) {
    const newFileSet = new Set(lastResult.newFiles ?? [])
    const unexpected = lastResult.toolCalls.filter(
      tc => !step.expectedTools.includes(tc.tool),
    )
    // 忽略纯探索性发现（stray newFiles 标记的）
    if (unexpected.length > 0 && lastResult.status !== 'done') {
      // 如果所有 unexpected 工具调用都是新文件探索，归类为 stray
      const allStray = unexpected.every(
        tc => tc.tool === 'read_file' || tc.tool === 'grep' || tc.tool === 'glob',
      )
      if (!allStray || newFileSet.size === 0) {
        return {
          type: 'deviated',
          reason: `步骤 ${step.id} 预期工具 [${step.expectedTools.join(', ')}]，实际使用了 [${unexpected.map(t => t.tool).join(', ')}]`,
          affectedStepId: step.id,
        }
      }
    }
  }

  // 4. stray — 执行了不在任何 step.expectedTools 中的工具
  const allExpectedTools = new Set(trace.steps.flatMap(s => s.expectedTools))
  const strayTools = lastResult.toolCalls.filter(
    tc => !allExpectedTools.has(tc.tool),
  )
  if (strayTools.length > 0 && (lastResult.newFiles?.length ?? 0) > 0) {
    return {
      type: 'stray',
      reason: `随机探索发现新文件：${lastResult.newFiles!.join(', ')}`,
      affectedStepId: lastResult.stepId,
    }
  }

  return { type: 'none', reason: '' }
}

/**
 * 序列化 trace 为 XML 格式，用于注入动态附录。
 * 同 renderTaskAnchor 模式——只在压缩时调用，不在每步写入。
 * prefix-cache 安全：追加在 message list 尾部。
 */
export function serializeTrace(trace: PlanExecutionTrace): string {
  if (trace.steps.length === 0) return ''

  const lines: string[] = [
    `<plan-execution-trace status="${trace.status}" depth="${trace.depthLayer}">`,
  ]

  // 步骤列表（最多 8 条，对应 system 深度上限）
  const maxSteps = MAX_STEPS_BY_DEPTH[trace.depthLayer]
  for (const step of trace.steps.slice(0, maxSteps)) {
    const attrs = [`id="${step.id}"`, `status="${step.status}"`]
    lines.push(`  <step ${attrs.join(' ')}>${escapeXml(step.description)}</step>`)
  }

  // 最近 5 条历史（避免过长）
  const recentHistory = trace.history.slice(-5)
  if (recentHistory.length > 0) {
    lines.push('  <recent-history>')
    for (const r of recentHistory) {
      const tools = r.toolCalls.map(tc => `${tc.tool}`).join(', ')
      const note = r.replanNote ? ` — ${escapeXml(r.replanNote)}` : ''
      lines.push(`    <result step="${r.stepId}" turn="${r.turnNumber}" status="${r.status}" tools="[${escapeXml(tools)}]"${note ? ` note="${note.trim()}"` : ''} />`)
    }
    lines.push('  </recent-history>')
  }

  lines.push('</plan-execution-trace>')
  return lines.join('\n')
}

// ─── Helpers ───────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
