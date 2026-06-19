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
  'apply_patch', 'deliver_task', 'todo', 'plan_submit', 'plan_close',
])

export interface ExplorationStallResult {
  blocked: boolean
  consecutiveExploreCount: number
  message: string | null
}

export function detectExplorationStall(
  trajectory: { tool: string; status: string }[],
  currentTool: string,
  threshold = 8,
): ExplorationStallResult {
  // Only gate exploration tools
  if (!EXPLORATION_TOOLS.has(currentTool)) {
    return { blocked: false, consecutiveExploreCount: 0, message: null }
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

  if (count < threshold) {
    return { blocked: false, consecutiveExploreCount: count, message: null }
  }

  return {
    blocked: true,
    consecutiveExploreCount: count,
    message: [
      `Exploration stall: ${count} consecutive exploration tools (grep/read_file/glob/...) without any code changes.`,
      'You have enough context. Write the test or implementation now.',
      'If you truly need more exploration, explicitly state why before the next read.',
    ].join('\n'),
  }
}
