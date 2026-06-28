import type { ToolHistoryEntry } from '../prompt/volatile.js'

// ── Types ──

export interface ExplorationStallResult {
  isStalled: boolean
  readOnlyStreak: number
  threshold: number
}

// ── Constants ──

/** Tools that modify the working tree — advancing past exploration. */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'hash_edit',
  'apply_patch',
  'ast_edit',
])

/** Tools that are read-only query operations — these advance exploration but don't modify. */
const READ_TOOLS = new Set([
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

const DEFAULT_STALL_THRESHOLD = 5

// ── Detection ──

/**
 * Detect exploration stall: agent has been reading/grepping for many
 * consecutive turns without ever writing. This indicates the agent is
 * stuck in an information-gathering loop without making progress.
 *
 * Ported from oh-my-pi's `exploration-stall.ts` — supplements convergence
 * detection's tool-fingerprint approach with a behavior-pattern dimension.
 */
export function detectExplorationStall(
  history: ToolHistoryEntry[],
  threshold: number = DEFAULT_STALL_THRESHOLD,
): ExplorationStallResult {
  let readOnlyStreak = 0

  // Walk from most recent to oldest, counting consecutive read-only turns.
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (WRITE_TOOLS.has(entry.tool)) break           // progress made — reset
    if (READ_TOOLS.has(entry.tool)) { readOnlyStreak++; continue }
    // Non-read, non-write tools (bash, run_tests, git, todo, delegate, etc.)
    // don't count toward either direction — they're neutral for this metric.
    // We break on write but continue past neutral tools so a bash between
    // reads doesn't falsely reset the streak.
  }

  return {
    isStalled: readOnlyStreak >= threshold,
    readOnlyStreak,
    threshold,
  }
}
