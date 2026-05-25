import type { StarDomainId } from '../../agent/star-domain.js'
import type { GlanceBus } from './glance-bus.js'

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
}

export function domainForTool(name: string): StarDomainId {
  return TOOL_DOMAIN_MAP[name] ?? 'tianfu'
}

export function glanceOnToolStart(bus: GlanceBus, toolName: string): void {
  bus.setActive(domainForTool(toolName))
}

export function glanceOnToolResult(bus: GlanceBus, toolName: string, isError: boolean): void {
  const domain = domainForTool(toolName)
  if (isError) bus.pushAlert(domain, `${toolName} failed`)
  else bus.reset(domain)
}
