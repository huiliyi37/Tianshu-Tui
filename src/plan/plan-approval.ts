/**
 * Plan Approval — 批准闭环共享内核（TUI slash 命令与 server 桌面路由共用）。
 *
 * 闭环三层守卫（缺一即是 TUI/桌面行为分叉）：
 * 1. 内容校验：空计划/占位符草稿在批准边界硬拒（绝不把被掏空的文件标 APPROVED）。
 * 2. 锚点漂移复查：非阻断——计划写成后代码可能已变化，漂移注入 kickoff 让执行方以现实为准。
 * 3. 分波 kickoff：指示 read_file → plan_task(execute=true)/team_orchestrate 逐波过审查门 → plan_close。
 *
 * 缓存纪律：kickoff 是用户边界的 append 消息，纯追加不碰前缀；本模块不注入任何 prompt 块。
 */

import { readPlan, approvePlan, type PlanDocument } from './plan-store.js'
import { validatePlanContentForApproval } from '../tools/plan.js'
import { extractRequiredSkills } from '../agent/skill-gate.js'

/** Build the kickoff prompt that drives wave-by-wave execution of an approved plan. */
export function buildPlanKickoff(slug: string, title: string, approach?: string, anchorDriftNote?: string, requiredSkills?: string[]): string {
  let msg = `开始执行已批准方案「${title}」(.rivet/plans/${slug}.md)。先 read_file 读取该计划,然后用 plan_task(execute=true) 或 team_orchestrate 把任务按波次并行执行、逐波过审查门;开工前用 todo 列出有序步骤跟踪进度,全部完成后 plan_close。`
  if (approach) msg += `\nSelected approach: ${approach} — 只执行此方案,勿执行未选中的备选。`
  // 技能契约指令（长庚域事故 2026-07-25）：计划点名的 skill 是该计划专属的
  // 流程契约。skill 正文已瘦身为纯增量（与前缀纪律不重叠），警告只钉核心
  // 语义；executePlan 入口另有技能门禁硬拦（skill-gate.ts）兜底派发路径。
  if (requiredSkills && requiredSkills.length > 0) {
    msg += `\n⚠ 本计划点名了流程 skill：${requiredSkills.join('、')}——这是计划专属契约,开工前先用 skill(name="…") 逐个加载并遵循,跳过将被技能门禁硬拦。`
  }
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
  /** 计划点名且本运行时可加载的流程 skill（技能契约，已注入 kickoff）。 */
  requiredSkills?: string[]
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

  // 技能契约：提取计划点名的 skill，过滤到本运行时可加载的（点名了但注册表
  // 没有的不指示加载——skill() 调不到只会白费一轮）。best-effort，提取失败不
  // 影响批准。
  let requiredSkills: string[] | undefined
  try {
    const { skillRegistry } = await import('../skills/skill-loader.js')
    const available = new Set(skillRegistry.list().map(s => s.name.toLowerCase()))
    const named = extractRequiredSkills(existing.content).filter(n => available.has(n.toLowerCase()))
    if (named.length > 0) requiredSkills = named
  } catch {
    // 技能契约是增强注入；提取器故障不得阻断批准闭环。
  }

  return {
    ok: true,
    approved,
    existing,
    driftNote,
    kickoff: buildPlanKickoff(slug, approved.title, resolvedApproach, driftNote, requiredSkills),
    ...(requiredSkills ? { requiredSkills } : {}),
  }
}
