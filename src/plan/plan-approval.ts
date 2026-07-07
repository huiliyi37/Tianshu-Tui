/**
 * Plan Approval — 批准闭环共享内核（TUI slash 命令与 server 桌面路由共用）。
 *
 * 闭环四层守卫（缺一即是 TUI/桌面行为分叉）：
 * 1. 内容校验：空计划/占位符草稿在批准边界硬拒（绝不把被掏空的文件标 APPROVED）。
 * 2. 锚点漂移复查：非阻断——计划写成后代码可能已变化，漂移注入 kickoff 让执行方以现实为准。
 * 3. 分波 kickoff：指示 read_file → plan_task(execute=true)/team_orchestrate 逐波过审查门 → plan_close。
 * 4. 低阶模型留痕：cheap tier 产出的计划在 kickoff 里明示，提醒复核关键改动点。
 *
 * 缓存纪律：kickoff 是用户边界的 append 消息，纯追加不碰前缀；本模块不注入任何 prompt 块。
 */

import { readPlan, approvePlan, type PlanDocument } from './plan-store.js'
import { validatePlanContentForApproval } from '../tools/plan.js'

/** Build the kickoff prompt that drives wave-by-wave execution of an approved plan. */
export function buildPlanKickoff(slug: string, title: string, approach?: string, anchorDriftNote?: string): string {
  let msg = `开始执行已批准方案「${title}」(.rivet/plans/${slug}.md)。先 read_file 读取该计划,然后用 plan_task(execute=true) 或 team_orchestrate 把任务按波次并行执行、逐波过审查门;开工前用 todo 列出有序步骤跟踪进度,全部完成后 plan_close。`
  if (approach) msg += `\nSelected approach: ${approach} — 只执行此方案,勿执行未选中的备选。`
  if (anchorDriftNote) msg += `\n\n⚠ 锚点漂移提示——以下计划引用与当前工作区不符（计划写成后代码可能已变化）:\n${anchorDriftNote}\n执行时以当前源码为准,先用工具核实真实位置再动手,并把每处偏差记入交付报告;若漂移改变了方案方向,暂停执行向用户说明。`
  return msg
}

export interface PlanApprovalSuccess {
  ok: true
  /** 批准后的计划文档（status=approved）。 */
  approved: PlanDocument
  /** 批准前读到的文档（携带 model/modelTier 留痕）。 */
  existing: PlanDocument
  /** 锚点漂移说明（无漂移时 undefined）。 */
  driftNote?: string
  /** 分波执行 kickoff 提示词（已含 approach/漂移注入），作为下一轮用户消息提交。 */
  kickoff: string
  /** cheap tier 产出计划的复核警告（非 cheap 时 undefined）。 */
  tierWarning?: string
}

export interface PlanApprovalFailure {
  ok: false
  /** not-found: 计划不存在；invalid-content: 空计划/占位符校验拒绝。 */
  code: 'not-found' | 'invalid-content'
  reason: string
  /** invalid-content 时携带标题便于提示。 */
  title?: string
}

export type PlanApprovalResult = PlanApprovalSuccess | PlanApprovalFailure

/**
 * 带守卫的批准：校验 → 漂移复查 → 落盘 APPROVED → 组装 kickoff。
 * 不做任何 UI/会话副作用（setActivePlan、消息提交由调用方接线），保持可测纯粹。
 */
export async function approvePlanWithGuards(
  cwd: string,
  slug: string,
  resolvedApproach?: string,
): Promise<PlanApprovalResult> {
  // Empty/invalid-plan hard-fail at the approval boundary (kimi-code borrow):
  // never mark a stale draft or gutted file APPROVED + kick off execution.
  const existing = await readPlan(cwd, slug)
  if (!existing) {
    return { ok: false, code: 'not-found', reason: `Plan not found: "${slug}".` }
  }
  const check = validatePlanContentForApproval(existing.content)
  if (!check.ok) {
    return { ok: false, code: 'invalid-content', reason: check.reason ?? '计划内容未通过批准校验。', title: existing.title }
  }

  // Approval-time anchor drift recheck (non-blocking): the plan was written
  // against an earlier tree state — concurrent sessions / elapsed time drift
  // anchors. Aged plans are normal, so drift never blocks approval; it is
  // surfaced to the user and injected into the kickoff prompt so the executor
  // treats reality as ground truth and logs deviations in the delivery report.
  let driftNote: string | undefined
  try {
    const { checkPlanFactAnchors, formatAnchorDrifts } = await import('./plan-fact-anchors.js')
    const report = await checkPlanFactAnchors(existing.content, cwd)
    if (report.drifts.length > 0) driftNote = formatAnchorDrifts(report.drifts)
  } catch {
    // Best-effort — the guard itself must never break approval.
  }

  const approved = await approvePlan(cwd, slug)
  if (!approved) {
    return { ok: false, code: 'not-found', reason: `Plan not found: "${slug}".` }
  }

  // 低阶模型留痕警告：flash 出的计划真实度不可控（事故链：大重构计划丢功能），
  // 批准时明示产出模型，提醒复核关键改动点。不阻断——用户已看过计划正文。
  const tierWarning = existing.modelTier === 'cheap'
    ? `⚠ 本计划由低阶模型产出（${existing.model}），建议对关键改动点复核后再放行执行。`
    : undefined

  return {
    ok: true,
    approved,
    existing,
    driftNote,
    kickoff: buildPlanKickoff(slug, approved.title, resolvedApproach, driftNote),
    tierWarning,
  }
}
