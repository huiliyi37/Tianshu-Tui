/**
 * Per-tool artifact wrapping thresholds.
 *
 * Background: all tools previously used a single global threshold from
 * pruneThresholds(contextWindow).minChars for deciding whether to wrap
 * output in an artifact. Different tools have different output
 * characteristics — read_file output is large code files, grep output
 * is compact search results, bash output varies widely. A single
 * threshold means either over-wrapping (creating unnecessary artifact
 * references for compact output) or under-wrapping (letting large
 * outputs inflate message history).
 *
 * This module provides per-tool multipliers so each tool can tune its
 * artifact threshold to its typical output size while still scaling
 * with the context window.
 *
 * Cache impact: zero. Only changes the internal threshold for
 * artifact wrapping decisions. Does not change tool definitions,
 * system prompt, engine.ts request construction, or successful tool
 * output format.
 */
import { pruneThresholds } from '../compact/constants.js'

/** Per-tool multiplier applied to pruneThresholds(contextWindow).minChars.
 *  Multipliers > 1.0 mean higher threshold → more content stays inline.
 *  Multipliers < 1.0 mean lower threshold → wraps smaller outputs too. */
const TOOL_ARTIFACT_MULTIPLIERS: Record<string, number> = {
  read_file: 5.0,   // code files are large; prefer inline up to ~150K on 1M window
  bash: 1.67,        // command output varies; ~50K threshold on 1M window
  grep: 0.67,        // search results are compact; wrap earlier at ~20K
  run_tests: 3.33,   // test output can be long; ~100K threshold on 1M window
  diff: 2.0,         // diffs are moderate; ~60K on 1M window
  glob: 0.5,         // file lists are very compact
  repo_map: 0.5,     // file trees are compact
  inspect_project: 0.5, // project summaries are compact
  web_fetch: 1.0,    // web content varies; default
  read_section: 5.0, // same as read_file — content already on disk
}

const DEFAULT_MULTIPLIER = 1.0

/**
 * Get the per-tool artifact wrapping threshold.
 *
 * Returns pruneThresholds(contextWindow).minChars multiplied by the
 * tool-specific factor. Falls back to the unmultiplied base when
 * contextWindow is unknown.
 *
 * @param toolName - The tool definition name (e.g. 'read_file', 'bash')
 * @param contextWindow - The active context window size in tokens
 */
export function getToolArtifactThreshold(
  toolName: string,
  contextWindow: number | undefined,
): number {
  const base = contextWindow != null && contextWindow > 0
    ? pruneThresholds(contextWindow).minChars
    : 800 // legacy default for unknown window
  const multiplier = TOOL_ARTIFACT_MULTIPLIERS[toolName] ?? DEFAULT_MULTIPLIER
  return Math.round(base * multiplier)
}
