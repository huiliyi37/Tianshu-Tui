/** 匹配开头的 `cd <path> && `（path 可带单/双引号），可重复出现。 */
const CD_BOILERPLATE_RE = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*/

const TARGET_MAX_CHARS = 50

export type BashCommandActivity = 'readonly' | 'productive'

/** Shell control/redirection syntax makes a command unsafe to prove read-only. */
const BASH_EFFECTFUL_SYNTAX_RE = /(?:&&|\|\||[;|<>`&\r\n]|\$\()/

/** Commands whose single-process form has no project-state write action. */
const BASH_SIMPLE_READONLY_RE =
  /^(?:grep|rg|ls|cat|head|tail|wc|jq|sort|uniq|pwd|which|file|stat|du|df|ps|top)(?:\s|$)/

/** Git subcommands that only inspect repository state in their normal form. */
const BASH_GIT_READONLY_RE =
  /^git\s+(?:log|status|diff|show|grep|rev-parse|ls-files)(?:\s|$)/

/** Narrow sed allowance: line-range printing only (`sed -n '1,20p' file`). */
const BASH_SED_PRINT_RE =
  /^sed\s+-n\s+(['"])(?:\d+|\$)(?:,(?:\d+|\$))?p\1(?:\s+--)?(?:\s+\S+)+$/

/** Reading one environment variable is observational; arbitrary echo remains productive. */
const BASH_ECHO_ENV_RE =
  /^echo\s+\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/

function stripCdBoilerplate(command: string): string {
  let rest = command
  while (CD_BOILERPLATE_RE.test(rest)) {
    const stripped = rest.replace(CD_BOILERPLATE_RE, '')
    if (stripped.trim() === '') break
    rest = stripped
  }
  return rest.trim()
}

/**
 * Conservatively classify a full bash command before its history target is
 * truncated. Anything ambiguous is productive: false negatives only retain
 * the stronger convergence guidance, while false read-only labels suppress it.
 */
export function classifyBashCommandActivity(command: string): BashCommandActivity {
  let rest = stripCdBoilerplate(command)
  if (rest.startsWith('rtk ')) rest = rest.slice(4).trimStart()
  if (rest === '' || BASH_EFFECTFUL_SYNTAX_RE.test(rest)) return 'productive'

  if (BASH_GIT_READONLY_RE.test(rest)) {
    return /(?:^|\s)--(?:output|ext-diff|textconv|open-files-in-pager)(?:=|\s|$)/.test(rest)
      ? 'productive'
      : 'readonly'
  }
  if (rest.startsWith('sed ')) {
    return BASH_SED_PRINT_RE.test(rest) && !/(?:^|\s)-i(?:\s|$)/.test(rest)
      ? 'readonly'
      : 'productive'
  }
  if (/^sort(?:\s|$)/.test(rest)) {
    return /(?:^|\s)(?:-o\S*|--(?:output|compress-program)(?:=\S*)?)(?:\s|$)/.test(rest)
      ? 'productive'
      : 'readonly'
  }
  if (/^rg(?:\s|$)/.test(rest) && /(?:^|\s)--pre(?:=|\s)/.test(rest)) {
    return 'productive'
  }
  if (BASH_ECHO_ENV_RE.test(rest)) return 'readonly'
  return BASH_SIMPLE_READONLY_RE.test(rest) ? 'readonly' : 'productive'
}

/**
 * 从 bash 命令提取历史/信息素/轨迹用的 target。
 *
 * 会话 5158719d 根因：`command.slice(0, 50)` 对本仓库几乎所有命令截出
 * 同一个 `cd <repo-path> && ` 前缀 → dead-end 信息素 target 失去区分度 →
 * 双向子串匹配全命中 → 天权提示每条 bash 都响。先剥 cd 样板再截断，
 * target 恢复「这条命令实际做什么」的语义。
 */
export function bashCommandTarget(command: string): string {
  return stripCdBoilerplate(command).slice(0, TARGET_MAX_CHARS)
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
