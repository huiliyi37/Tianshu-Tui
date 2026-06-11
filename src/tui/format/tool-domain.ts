/**
 * T9 工具 → 星域映射（框架无关，移植自 surface/tool-domain.ts，去掉 GlanceBus 依赖）。
 *
 * 用于 GlanceBar 的 domain zone：执行某工具时切到对应星域的 glyph/name。
 * 子代理编排（delegate_* / team_orchestrate）归天机域。
 */

import { STAR_DOMAINS, type StarDomainId } from '../../agent/star-domain.js'

const TOOL_DOMAIN_MAP: Record<string, StarDomainId> = {
  grep: 'tianxuan',
  glob: 'tianxuan',
  read_file: 'tianxuan',
  repo_map: 'tianxuan',
  inspect_project: 'tianxuan',
  edit_file: 'tianliang',
  write_file: 'tianliang',
  bash: 'pojun',
  run_tests: 'tianquan',
  delegate_task: 'tianji',
  delegate_batch: 'tianji',
  team_orchestrate: 'tianji',
}

/** 该工具是否归子代理编排域（天机）。 */
export function isDelegationTool(name: string): boolean {
  return name === 'delegate_task' || name === 'delegate_batch' || name === 'team_orchestrate'
}

/** 返回工具对应星域 id；无映射返回 null。 */
export function domainForTool(name: string): StarDomainId | null {
  return TOOL_DOMAIN_MAP[name] ?? null
}

/** 返回工具对应星域的 GlanceBar 徽标（glyph + name）；无映射返回 null。 */
export function domainBadge(name: string): { glyph: string; name: string } | null {
  const id = domainForTool(name)
  if (!id) return null
  const d = STAR_DOMAINS[id]
  return { glyph: d.uiPersona.glyph, name: d.name }
}
