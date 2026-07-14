/** Ask Mode — 只读问答（Cursor Ask 对标）：只探索与回答，禁止写改与执行。 */

/** Ask Mode 状态（两态：off / asking） */
export type AskModeState = 'off' | 'asking'

/**
 * Ask Mode 下允许的工具 — 纯只读探索 + 澄清。
 * 排除 plan（规划专属）、写改工具、bash、delegate_*、run_tests。
 */
export const ASK_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_section', 'grep', 'glob', 'repo_map',
  'inspect_project', 'related_tests', 'diff', 'todo',
  'repo_graph', 'web_fetch', 'web_search', 'memory',
  'ask_user_question',
])

export interface AskModeResult {
  /** 是否允许执行 */
  allowed: boolean
  /** 拒绝原因（allowed=false 时） */
  reason?: string
}

/** 检查工具是否在 ask-mode 下被允许 */
export function checkAskMode(
  state: AskModeState,
  toolName: string,
): AskModeResult {
  if (state === 'off') return { allowed: true }
  if (ASK_MODE_ALLOWED_TOOLS.has(toolName)) return { allowed: true }
  return {
    allowed: false,
    reason:
      'Ask Mode is active — write and execute operations are blocked. ' +
      'Allowed tools: read, grep, glob, repo_map, inspect_project, related_tests, ' +
      'diff, repo_graph, web_search, web_fetch, memory, todo, ask_user_question. ' +
      'Exit Ask Mode (composer Ask→Agent, or /ask) before writing or running commands.',
  }
}
