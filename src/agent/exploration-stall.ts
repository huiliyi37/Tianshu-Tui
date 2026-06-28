import type { ToolHistoryEntry } from '../prompt/volatile.js'

// ── Types ──

export interface ExplorationStallResult {
  /** Whether the current turn should be hard-blocked. */
  blocked: boolean
  /** Total consecutive exploration tools including the current one. */
  consecutiveExploreCount: number
  /** Hard-block message when blocked; null otherwise. */
  message: string | null
  /** Soft advisory when in the advisory zone; null otherwise. */
  advisory: string | null
}

// ── Constants ──

/** Read-only query tools that advance exploration without modifying code. */
export const EXPLORATION_TOOLS = new Set([
  'grep',
  'glob',
  'read_file',
  'read_section',
  'semantic_search',
  'repo_map',
  'inspect_project',
  'file_info',
  'related_tests',
  'diff',
  'lsp_find_references',
  'lsp_goto_definition',
  'web_search',
  'web_fetch',
])

const DEFAULT_HARD_THRESHOLD = 15
const ADVISORY_THRESHOLD = 12

// ── Detection ──

/**
 * Detect exploration stall: agent has been reading/grepping for many
 * consecutive turns without ever writing. This indicates the agent is
 * stuck in an information-gathering loop without making progress.
 *
 * Signature expected by callers/tests:
 *   detectExplorationStall(history, currentTool, threshold?)
 *
 * - `currentTool` is included in the count.
 * - Any non-exploration tool resets the streak.
 * - Default behavior: advisory at 12-14 consecutive, hard-block at 15+.
 * - Explicit `threshold` disables advisory and hard-blocks at that count.
 */
export function detectExplorationStall(
  history: ToolHistoryEntry[],
  currentTool: string,
  threshold?: number,
): ExplorationStallResult {
  if (!EXPLORATION_TOOLS.has(currentTool)) {
    return { blocked: false, consecutiveExploreCount: 0, message: null, advisory: null }
  }

  let consecutiveExploreCount = 1
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (EXPLORATION_TOOLS.has(entry.tool)) {
      consecutiveExploreCount++
    } else {
      break
    }
  }

  const hardThreshold = threshold ?? DEFAULT_HARD_THRESHOLD

  if (consecutiveExploreCount >= hardThreshold) {
    return {
      blocked: true,
      consecutiveExploreCount,
      message: `Exploration stall detected: ${consecutiveExploreCount} consecutive read-only tools. Time to act.`,
      advisory: null,
    }
  }

  const advisory =
    threshold === undefined && consecutiveExploreCount >= ADVISORY_THRESHOLD
      ? `You have used ${consecutiveExploreCount} consecutive exploration tools. Consider taking action instead of gathering more information.`
      : null

  return {
    blocked: false,
    consecutiveExploreCount,
    message: null,
    advisory,
  }
}
