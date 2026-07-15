/**
 * W1-A2: single source of truth for the artifact recovery-reference contract.
 *
 * All tools producing artifact refs MUST place "[artifact:XYZ]" as the LAST
 * token of the tool result — usage instructions, summaries, or other suffixes
 * go BEFORE it. See
 * docs/superpowers/plans/2026-05-24-工具输出 artifact 标记格式统一与窗口感知预算.md.
 *
 * Every lossy transform (budget eviction, turn-read budget, context-pressure
 * truncation, tool-type budgets, stale-round compaction) must preserve this
 * marker so the model can still call read_section(artifactId=...) to recover
 * the original content.
 *
 * Regex source of truth: real marker text `[artifact:abc_123]`, contract
 * originally defined at src/compact/stale-round.ts:4-10 (now re-exported from
 * here). Do NOT create near-miss variants of this regex elsewhere.
 */
export const ARTIFACT_MARKER_REGEX = /\[artifact:([A-Za-z0-9_-]+)\]\s*$/

/**
 * Preserve the trailing artifact recovery marker across a lossy replacement.
 *
 * - Only recognizes a REAL marker at the very end of `originalContent`.
 * - If the replacement already ends with a marker, returns it unchanged
 *   (no duplication).
 * - If the original has no trailing marker, returns the replacement as-is
 *   (never invents a marker).
 * - Otherwise appends the original marker as the last token of the
 *   replacement, honoring the marker-last contract.
 */
export function preserveRecoveryReference(originalContent: string, replacementContent: string): string {
  const match = originalContent.match(ARTIFACT_MARKER_REGEX)
  if (!match) return replacementContent
  if (ARTIFACT_MARKER_REGEX.test(replacementContent)) return replacementContent
  const marker = match[0].trimEnd()
  return `${replacementContent}\n${marker}`
}
