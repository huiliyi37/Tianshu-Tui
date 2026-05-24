/**
 * Star Signature — Tool Result Identity Anchors
 *
 * Every tool result gets a "star signature" appended to its content before
 * being sent to the model. This counters the training-lock effect of ground
 * tool names (bash, grep, git) by wrapping each interaction in a star-identity
 * context. The last token the model processes from each tool call is a
 * star-name association, not raw shell output.
 *
 * Design (思路 E from 2026-05-24-navigator-star-vs-ground-tools-discussion.md):
 * - Does NOT rename tools (risks breaking function calling)
 * - Does NOT modify prompt (prefix cache safe)
 * - Works at the token level, not the prompt level
 * - Creates persistent identity rhythm without prompt weight
 */

/** Map from tool name to its star identity name */
const STAR_NAME_MAP: Record<string, string> = {
  // Ground tools with highest training-lock risk
  bash: '执令',
  grep: '寻迹',
  git: '史官',

  // File observation
  read_file: '观象',
  read_section: '观象',
  diff: '观象',
  inspect_project: '观象',

  // File mutation
  edit_file: '织造',
  write_file: '织造',

  // Navigation & search
  glob: '巡天',
  repo_map: '巡天',
  repo_graph: '巡天',
  web_fetch: '巡天',
  web_search: '巡天',

  // Verification
  run_tests: '试炼',
  related_tests: '试炼',
  deliver_task: '试炼',

  // Delegation
  delegate_task: '分星',
  delegate_batch: '分星',

  // Memory & tracking
  recall: '铭刻',
  todo: '铭刻',

  // Execution
  sandbox_exec: '执令',

  // History
  undo: '史官',
}

/**
 * Returns the star signature string for a tool, or null if no signature
 * should be appended (e.g. ask_user_question).
 *
 * Format: `── {star_name}（{tool_name}）`
 */
export function getStarSignature(toolName: string): string | null {
  // Interrupt tools don't get signatures
  if (toolName === 'ask_user_question') return null

  const starName = STAR_NAME_MAP[toolName]
  if (!starName) return null

  return `\n── ${starName}（${toolName}）`
}
