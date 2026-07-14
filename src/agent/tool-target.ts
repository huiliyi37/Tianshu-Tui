/** 匹配开头的 `cd <path> && `（path 可带单/双引号），可重复出现。 */
const CD_BOILERPLATE_RE = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*/

const TARGET_MAX_CHARS = 50

/**
 * 从 bash 命令提取历史/信息素/轨迹用的 target。
 *
 * 会话 5158719d 根因：`command.slice(0, 50)` 对本仓库几乎所有命令截出
 * 同一个 `cd <repo-path> && ` 前缀 → dead-end 信息素 target 失去区分度 →
 * 双向子串匹配全命中 → 天权提示每条 bash 都响。先剥 cd 样板再截断，
 * target 恢复「这条命令实际做什么」的语义。
 */
export function bashCommandTarget(command: string): string {
  let rest = command
  while (CD_BOILERPLATE_RE.test(rest)) {
    const stripped = rest.replace(CD_BOILERPLATE_RE, '')
    if (stripped.trim() === '') break // 纯 cd：cd 本身就是目标，保留
    rest = stripped
  }
  return rest.trim().slice(0, TARGET_MAX_CHARS)
}

/** file_path > path > command > action 的统一 target 提取（原 4 处逐字重复的三元链）。 */
export function toolTargetFromInput(toolName: string, input: Record<string, unknown>): string {
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.command === 'string') return bashCommandTarget(input.command)
  // 视觉/自动化 action 型工具：action（+ url/app）才是语义目标。全部塌缩成
  // 工具名会让 dead-end 信息素失去区分度，也让 self-verify 无法识别
  // 「screenshot/console 是验证动作」。范围刻意限定在这三个工具——git/plan
  // 等也有 action 字段，但它们的 target 语义已被下游消费方按工具名依赖。
  if (VISUAL_ACTION_TOOLS.has(toolName) && typeof input.action === 'string') {
    const detail = typeof input.url === 'string' ? input.url : typeof input.app === 'string' ? input.app : ''
    return `${input.action}${detail ? ` ${detail}` : ''}`.slice(0, TARGET_MAX_CHARS)
  }
  return toolName
}

const VISUAL_ACTION_TOOLS = new Set(['browser_debug', 'browser', 'computer_use'])
