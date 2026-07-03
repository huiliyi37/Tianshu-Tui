/** Plan-phase star-domain delegation — shared by plan-mode block, writing-plans workflow, TUI/desktop entry. */

export const WRITING_PLANS_SKILL = 'writing-plans'

/** Task-type → star-domain authority routing (read-only scouts in plan mode). */
export const PLAN_DELEGATION_AUTHORITY_LINES = [
  '架构层次/模块边界 → authority: "tianquan"',
  '测试覆盖/复现路径 → authority: "yaoguang"',
  '前提假设/边界条件 → authority: "tianji"',
  '变更影响/回归风险 → authority: "tianfu"',
  '跨域视角/备选方案 → authority: "tianxuan"',
] as const

export function renderPlanDelegationGuide(): string {
  return `星域委派（只读探查）— 3+ 独立模块或需多视角审视时用 \`delegate_task\` / \`delegate_batch\`：
- profile: \`code_scout\`（代码）或 \`doc_scout\`（文档）；kind: \`code_search\` / \`doc_research\`
- 按任务类型选 authority：${PLAN_DELEGATION_AUTHORITY_LINES.join('；')}
- findings 是待核验假设 — 引用前用 read_file / grep 独立确认
- 禁止 patcher；禁止把主线任务委派出去`
}

/** Minimal agent surface for activating the writing-plans workflow. */
export interface PlanWorkflowAgent {
  planModeState?: 'off' | 'planning'
  enterPlanMode?(opts?: { planFilePath?: string }): void
  markSkillInvoked?(name: string): void
}

/** Enter plan mode (if needed) and pin writing-plans skill for appendix injection. */
export function activateWritingPlanWorkflow(agent: PlanWorkflowAgent): void {
  if (agent.planModeState !== 'planning') {
    agent.enterPlanMode?.()
  } else {
    agent.markSkillInvoked?.(WRITING_PLANS_SKILL)
  }
}
