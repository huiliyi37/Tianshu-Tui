/**
 * Profile → 人类友好职能标签映射。
 *
 * 把英文 profile 名（code_scout / doc_scout / reviewer…）映射为中文双字标签，
 * 供 TUI 子代理面板使用。未知 profile 回退为「worker」。
 *
 * 设计取舍：标签固定双字 + 可选领域后缀，保持视觉对齐和行宽稳定。
 * 不依赖 profile-registry（避免 TUI 层引入 agent 层依赖循环）。
 */

import { starDomainRegistry } from '../../agent/star-domain-registry.js'

/** profile → (职能名, 可选领域后缀) */
const PROFILE_LABELS: Record<string, { role: string; scope?: string }> = {
  // 侦察系（只读探查）
  code_scout: { role: '侦察', scope: '代码' },
  doc_scout: { role: '侦察', scope: '文档' },
  architect: { role: '架构' },
  troubleshooter: { role: '诊断' },
  designer: { role: '设计' },

  // 审查系
  reviewer: { role: '审查' },
  council_expert: { role: '会诊' },
  format_checker: { role: '检查', scope: '格式' },

  // 规划系
  planner: { role: '规划' },

  // 执行系（写入）
  patcher: { role: '修补' },
  verifier: { role: '验证' },
  adversarial_verifier: { role: '对抗验证' },
  lint_fixer: { role: '修复', scope: 'lint' },
  test_scaffolder: { role: '生成', scope: '测试' },
  import_organizer: { role: '整理', scope: '导入' },
  doc_syncer: { role: '同步', scope: '文档' },
  type_fixer: { role: '修复', scope: '类型' },
}

/** 返回 profile 的中文职能标签；未知 profile 回退 'worker'。 */
export function profileLabel(profile: string): string {
  const entry = PROFILE_LABELS[profile]
  if (!entry) return 'worker'
  return entry.scope ? `${entry.role}·${entry.scope}` : entry.role
}

/**
 * 从星域 id 查询星名（如 'pojun' → '破军'）。
 * 未知或 undefined authority 返回 undefined（调用方回退到纯 profile 标签）。
 * 从 star-domain-registry 查询，支持内置 + 用户自定义域。
 */
export function authorityStarName(authority: string | undefined): string | undefined {
  if (!authority) return undefined
  const domain = starDomainRegistry.get(authority)
  return domain?.name
}
