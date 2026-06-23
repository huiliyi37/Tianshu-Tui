/**
 * Exploration stall detector — gates models that loop on exploration tools
 * (grep/glob/read_file/...) without ever writing code or running tests.
 *
 * Triggered when consecutive exploration-only tool calls reach threshold,
 * counting from the last action tool (edit_file/write_file/bash/run_tests/
 * hash_edit/deliver_task/todo) backwards through the trajectory.
 *
 * Pure function — called from tool-pipeline before tool execution.
 */

export const EXPLORATION_TOOLS = new Set([
  'grep', 'read_file', 'glob', 'semantic_search', 'repo_map',
  'repo_graph', 'related_tests', 'lsp_goto_definition', 'lsp_find_references',
  'file_info', 'inspect_project',
])

const ACTION_TOOLS = new Set([
  'edit_file', 'write_file', 'hash_edit', 'bash', 'run_tests',
  'apply_patch', 'deliver_task', 'todo', 'plan',
])

export interface ExplorationStallResult {
  blocked: boolean
  consecutiveExploreCount: number
  message: string | null
  /** 软警告：不阻断工具，只在输出末尾追加提示 */
  advisory: string | null
}

export function detectExplorationStall(
  trajectory: { tool: string; status: string }[],
  currentTool: string,
  threshold?: number,
): ExplorationStallResult {
  // Only gate exploration tools
  if (!EXPLORATION_TOOLS.has(currentTool)) {
    return { blocked: false, consecutiveExploreCount: 0, message: null, advisory: null }
  }

  // Count consecutive exploration tools from end of history backwards
  let count = 0
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const entry = trajectory[i]!
    if (EXPLORATION_TOOLS.has(entry.tool)) {
      count++
    } else if (ACTION_TOOLS.has(entry.tool)) {
      break
    }
    // Non-exploration, non-action tools (e.g. web_fetch, import_resource)
    // don't break the streak — they're neutral, like taking a note
  }
  count++ // include current tool

  // threshold parameter overrides HARD_BLOCK_THRESHOLD for backward compat.
  // When caller passes an explicit small threshold, they want strict blocking —
  // advisory zone is disabled (ADVISORY_THRESHOLD only applies to default 15).
  const hardBlock = threshold ?? 15
  const advisoryEnabled = threshold === undefined
  const ADVISORY_THRESHOLD = 12

  if (count >= hardBlock) {
    return {
      blocked: true,
      consecutiveExploreCount: count,
      message: [
        `Exploration stall: ${count} consecutive exploration tools (grep/read_file/glob/...) without any code changes.`,
        'You have enough context. Write the test or implementation now.',
        'If you truly need more exploration, explicitly state why before the next read.',
      ].join('\n'),
      advisory: null,
    }
  }

  if (advisoryEnabled && count >= ADVISORY_THRESHOLD) {
    return {
      blocked: false,
      consecutiveExploreCount: count,
      message: null,
      advisory: `ℹ Exploration stall advisory: ${count} consecutive exploration tools. Consider acting on your findings soon.`,
    }
  }

  return { blocked: false, consecutiveExploreCount: count, message: null, advisory: null }
}
