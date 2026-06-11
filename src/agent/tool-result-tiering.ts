/**
 * Tool Result Tiering for 1M windows.
 *
 * Tiers tool results BEFORE writing to the session, so the first-time
 * write is already in compact form. This preserves prefix cache integrity
 * because the message is never modified after initial insertion.
 *
 * Tier 0 (inline):        < 8K chars  — keep full content in session
 * Tier 1 (summary+disk):  8K-150K     — structured summary inline, full on disk
 * Tier 2 (minimal+disk):  > 150K      — filename + size inline, full on disk
 */

import type { ArtifactStore } from '../artifact/store.js'

const TIER_0_MAX_CHARS = 8_000
const TIER_1_MAX_CHARS = 150_000

export type TierLevel = 0 | 1 | 2

export interface TieringResult {
  content: string
  tier: TierLevel
  artifactId?: string
  originalChars: number
}

export function determineTier(charCount: number): TierLevel {
  if (charCount <= TIER_0_MAX_CHARS) return 0
  if (charCount <= TIER_1_MAX_CHARS) return 1
  return 2
}

/**
 * Convention shared with read-file.ts / prune.ts / stale-round.ts:
 * [artifact:X] is always the LAST token of an artifact-wrapped content string.
 */
const TRAILING_ARTIFACT_REF = /\[artifact:([A-Za-z0-9_-]+)]\s*$/

/** Extract an existing trailing artifact reference from tool result content. */
export function extractTrailingArtifactId(content: string): string | undefined {
  return TRAILING_ARTIFACT_REF.exec(content)?.[1]
}

/**
 * Tier a tool result: for small results, return as-is.
 * For larger results, save to artifact store and return a compact inline summary.
 *
 * @param toolName    Tool that produced the result
 * @param content     Full text content
 * @param target      Target path/identifier for artifact indexing
 * @param store       Artifact store for persisting large results
 * @param contextWindow Context window size
 * @param existingArtifactId Artifact already persisted by the tool itself
 *   (e.g. grep/bash artifact wrapping). Reused instead of saving a second
 *   copy — the tool-level artifact holds the untruncated original, while
 *   the content seen here may already be budget-truncated.
 */
export async function tierToolResult(
  toolName: string,
  content: string,
  target: string,
  store: ArtifactStore | undefined,
  contextWindow: number,
  existingArtifactId?: string,
): Promise<TieringResult> {
  if (contextWindow < 500_000) {
    return { content, tier: 0, originalChars: content.length }
  }

  const tier = determineTier(content.length)

  if (tier === 0) {
    return { content, tier: 0, originalChars: content.length }
  }

  let artifactId: string | undefined = existingArtifactId
  if (!artifactId && store) {
    try {
      artifactId = await store.save({
        tool: toolName,
        target,
        rawContent: content,
        summary: buildTierSummary(toolName, content, tier),
        sections: [],
      })
    } catch {
      return { content, tier: 0, originalChars: content.length }
    }
  }

  if (tier === 1) {
    const summary = buildTier1Inline(toolName, content, artifactId)
    return { content: summary, tier: 1, artifactId, originalChars: content.length }
  }

  const minimal = buildTier2Inline(toolName, content, target, artifactId)
  return { content: minimal, tier: 2, artifactId, originalChars: content.length }
}

function buildTierSummary(toolName: string, content: string, tier: TierLevel): string {
  const lines = content.split('\n')
  return `[tier-${tier} ${toolName}: ${content.length} chars, ${lines.length} lines]`
}

function buildTier1Inline(toolName: string, content: string, artifactId?: string): string {
  const lines = content.split('\n')
  const lineCount = lines.length
  const head = lines.slice(0, 30).join('\n')
  const tail = lines.slice(-10).join('\n')
  const ref = artifactId ? ` [artifact:${artifactId}]` : ''

  return [
    `[tiered-summary: ${toolName}, ${lineCount} lines, ${content.length} chars${ref}]`,
    head,
    `... ${Math.max(0, lineCount - 40)} lines omitted (full content on disk) ...`,
    tail,
  ].join('\n')
}

function buildTier2Inline(toolName: string, content: string, target: string, artifactId?: string): string {
  const lines = content.split('\n')
  const ref = artifactId ? ` [artifact:${artifactId}]` : ''
  return `[tiered-minimal: ${toolName} → ${target}, ${lines.length} lines, ${content.length} chars${ref}. Use read_section to access specific parts.]`
}
