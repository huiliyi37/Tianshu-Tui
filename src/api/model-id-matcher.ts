import {
  MODEL_ALIAS_TABLE,
  type ModelAliasEntry,
} from './model-aliases.js'

/**
 * Four-tier model-id matching pipeline (see docs/plans/2026-08-08-provider-
 * module-unification-refactor.md §模型别名表与 ID 匹配管道).
 *
 * Precise matching only holds for official direct endpoints + known models;
 * aggregator ids carry vendor prefixes / variant suffixes (siliconflow
 * `deepseek-ai/DeepSeek-V3`, openrouter `deepseek/deepseek-chat`, `:free`)
 * and self-hosted relays rename arbitrarily — so matching degrades through
 * four tiers instead of assuming global exact match:
 *
 *   L1 exact      — raw id hits the alias table verbatim
 *   L2 normalized — lowercase + strip vendor prefix / variant suffix, retry
 *   L3 fuzzy      — token-overlap score ≥ threshold; suggested, flagged
 *   L4 unknown    — skeleton output; metadata left for the user to fill
 *
 * Confidence gates persistence: L1/L2 backfill silently, L3 backfills marked
 * "inferred", L4 leaves fields blank. A wrong contextWindow silently written
 * would corrupt compaction and truncation behavior.
 */

export type MatchTier = 'exact' | 'normalized' | 'fuzzy' | 'unknown'

export interface ModelMatchResult {
  rawId: string
  tier: MatchTier
  /** Matched alias-table entry; undefined for L4 unknown. */
  entry?: ModelAliasEntry
  /** 1 for L1/L2; Jaccard score for L3; 0 for L4. */
  confidence: number
  /** True for L3 — backfill must be annotated "inferred, please confirm". */
  needsReview: boolean
}

/** Minimum token-overlap score for an L3 suggestion to be emitted. */
export const FUZZY_MATCH_THRESHOLD = 0.6

/**
 * L2 normalization: lowercase → (optionally) strip vendor prefix (first `/`)
 * → strip variant tags (`:free` / `@xxx`) → strip trailing date stamps
 * (`-20260101`). Keeping the prefix on the first L2 pass lets aggregator ids
 * (`deepseek-ai/DeepSeek-V4-Pro`) hit their prefixed alias entries instead of
 * collapsing into the bare official entry (different pricing metadata).
 */
export function normalizeModelId(rawId: string, stripVendorPrefix = true): string {
  let id = rawId.trim().toLowerCase()
  if (stripVendorPrefix) {
    const slash = id.indexOf('/')
    if (slash >= 0) id = id.slice(slash + 1)
  }
  const colon = id.indexOf(':')
  if (colon >= 0) id = id.slice(0, colon)
  const at = id.indexOf('@')
  if (at >= 0) id = id.slice(0, at)
  id = id.replace(/[-_](?:19|20)\d{6}$/, '')
  return id
}

function tokenize(id: string): Set<string> {
  return new Set(id.split(/[^a-z0-9]+/).filter(Boolean))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/** Match a single raw model id against the alias table. */
export function matchModelId(
  rawId: string,
  table: readonly ModelAliasEntry[] = MODEL_ALIAS_TABLE,
): ModelMatchResult {
  for (const entry of table) {
    if (entry.canonicalId === rawId || entry.aliases.includes(rawId)) {
      return { rawId, tier: 'exact', entry, confidence: 1, needsReview: false }
    }
  }

  // L2 — two passes: prefix-keeping (aggregator ids hit prefixed entries),
  // then prefix-stripping (variant ids hit the bare official entry).
  for (const stripVendorPrefix of [false, true] as const) {
    const normalized = normalizeModelId(rawId, stripVendorPrefix)
    if (!normalized) continue
    for (const entry of table) {
      const candidates = [entry.canonicalId, ...entry.aliases].map(c => normalizeModelId(c, stripVendorPrefix))
      if (candidates.includes(normalized)) {
        return { rawId, tier: 'normalized', entry, confidence: 1, needsReview: false }
      }
    }
  }

  const normalized = normalizeModelId(rawId)

  if (normalized) {
    const rawTokens = tokenize(normalized)
    let best: { entry: ModelAliasEntry; score: number } | undefined
    for (const entry of table) {
      for (const name of [entry.canonicalId, ...entry.aliases]) {
        const score = jaccard(rawTokens, tokenize(normalizeModelId(name)))
        if (score >= FUZZY_MATCH_THRESHOLD && (!best || score > best.score)) {
          best = { entry, score }
        }
      }
    }
    if (best) {
      return { rawId, tier: 'fuzzy', entry: best.entry, confidence: best.score, needsReview: true }
    }
  }

  return { rawId, tier: 'unknown', confidence: 0, needsReview: false }
}

/** Match a fetched model list; order preserved, unknowns kept as first-class results. */
export function matchModelIds(
  rawIds: string[],
  table: readonly ModelAliasEntry[] = MODEL_ALIAS_TABLE,
): ModelMatchResult[] {
  return rawIds.map(rawId => matchModelId(rawId, table))
}
