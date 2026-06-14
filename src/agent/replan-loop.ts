/**
 * Replan Loop — 自主修正循环 (U2)
 *
 * 由 detectDeviation() (在 plan-execution-trace.ts) 检测偏差，
 * 由 correctPlan() 追加修正步骤，
 * 由 injectReplanContext() 生成下一轮 prompt 的上下文注入。
 *
 * 纯函数模块——不可变更新，无副作用。
 */

import type {
  PlanExecutionTrace,
  PlanStep,
  DeviationResult,
} from './plan-execution-trace.js'

// ─── Types ─────────────────────────────────────────────────────

export interface CorrectPlanResult {
  /** 更新后的 trace（可能有新追加的步骤） */
  trace: PlanExecutionTrace
  /** 本次修正追加的步骤（空数组 = 无追加） */
  addedSteps: PlanStep[]
}

export interface ReplanContext {
  /** 注入到下一轮 prompt 的文本 */
  text: string
  /** 偏差类型（用于日志/追踪） */
  deviationType: DeviationResult['type']
}

// ─── correctPlan ───────────────────────────────────────────────

/**
 * U6/D1: trace-local replan step id. Derived from the count of existing
 * `replan-*` steps in this trace — no module-level mutable counter, so
 * concurrent sessions/traces never interleave or reset each other's ids.
 */
function nextStepId(trace: PlanExecutionTrace): string {
  const existing = trace.steps.filter(s => s.id.startsWith('replan-')).length
  return `replan-${existing + 1}`
}

/**
 * 根据偏差类型修正计划。不可变更新——返回新 trace + 追加步骤。
 *
 * - blocked:  追加 "诊断阻塞原因" 步骤，标记受影响步骤为 replanned
 * - deviated: 追加 "修正偏差" 步骤
 * - replanned: 标记剩余步骤为 skip → trace.status = 'completed'
 * - stray:    追加 "验证随机探索发现" 步骤
 * - stalled:  追加 "打破停滞" 步骤
 * - none:     无操作
 */
export function correctPlan(
  trace: PlanExecutionTrace,
  deviation: DeviationResult,
): CorrectPlanResult {
  switch (deviation.type) {
    case 'none':
      return { trace, addedSteps: [] }

    case 'blocked': {
      const step: PlanStep = {
        id: nextStepId(trace),
        description: `诊断阻塞原因 — ${deviation.reason}`,
        expectedTools: ['bash', 'read_file', 'grep'],
        verificationHint: '确认阻塞已解除或路径已切换',
        status: 'pending',
      }
      const steps = markAffectedStep(trace.steps, deviation.affectedStepId, 'replanned')
      return {
        trace: { ...trace, steps: [...steps, step], status: 'replanned' },
        addedSteps: [step],
      }
    }

    case 'deviated': {
      const step: PlanStep = {
        id: nextStepId(trace),
        description: `修正偏差 — ${deviation.reason}`,
        expectedTools: ['read_file'],
        verificationHint: '确认回到原计划路径',
        status: 'pending',
      }
      const steps = markAffectedStep(trace.steps, deviation.affectedStepId, 'replanned')
      return {
        trace: { ...trace, steps: [...steps, step], status: 'replanned' },
        addedSteps: [step],
      }
    }

    case 'replanned': {
      const steps = trace.steps.map(s =>
        s.status === 'pending' || s.status === 'active'
          ? { ...s, status: 'skip' as const }
          : s,
      )
      return {
        trace: { ...trace, steps, status: 'completed' },
        addedSteps: [],
      }
    }

    case 'stray': {
      const step: PlanStep = {
        id: nextStepId(trace),
        description: `验证随机探索发现 — ${deviation.reason}`,
        expectedTools: ['read_file', 'grep'],
        verificationHint: '确认探索发现是否相关于目标',
        status: 'pending',
      }
      return {
        trace: { ...trace, steps: [...trace.steps, step], status: 'replanned' },
        addedSteps: [step],
      }
    }

    case 'stalled': {
      const step: PlanStep = {
        id: nextStepId(trace),
        description: `打破停滞 — 选择最相关的未用工具推进`,
        expectedTools: ['todo', 'read_file', 'grep'],
        verificationHint: '确认 agent 恢复推进',
        status: 'pending',
      }
      return {
        trace: { ...trace, steps: [...trace.steps, step], status: 'replanned' },
        addedSteps: [step],
      }
    }
  }
}

// ─── injectReplanContext ───────────────────────────────────────

/**
 * 生成下一轮 prompt 的 replan context 文本。
 */
export function injectReplanContext(
  deviation: DeviationResult,
  addedSteps: PlanStep[],
): ReplanContext {
  if (deviation.type === 'none') {
    return { text: '', deviationType: 'none' }
  }

  const lines: string[] = [
    `<replan-context deviation="${deviation.type}">`,
    `偏差类型: ${deviationTypeLabel(deviation.type)}`,
  ]

  if (deviation.reason) {
    lines.push(`原因: ${deviation.reason}`)
  }

  if (addedSteps.length > 0) {
    lines.push('修正步骤:')
    for (const step of addedSteps) {
      lines.push(`  - ${step.description}`)
    }
  }

  lines.push('</replan-context>')
  return {
    text: lines.join('\n'),
    deviationType: deviation.type,
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function markAffectedStep(
  steps: PlanStep[],
  stepId: string | undefined,
  newStatus: PlanStep['status'],
): PlanStep[] {
  if (!stepId) return steps
  return steps.map(s =>
    s.id === stepId ? { ...s, status: newStatus } : s,
  )
}

function deviationTypeLabel(type: DeviationResult['type']): string {
  switch (type) {
    case 'blocked': return '阻塞 — 工具反复失败'
    case 'deviated': return '偏差 — 偏离预期工具路径'
    case 'replanned': return '提前完成 — 标记剩余步骤跳过'
    case 'stray': return '随机探索 — 发现计划外文件'
    case 'stalled': return '停滞 — 无工具调用回合过多'
    case 'none': return '无偏差'
  }
}
