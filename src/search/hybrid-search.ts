/**
 * Hybrid search: fuse BM25 (lexical) and vector (semantic) rankings.
 *
 * Reciprocal Rank Fusion (RRF) is used rather than score normalization because
 * BM25 and cosine scores live on incomparable scales. RRF only needs the rank
 * of each item in each list, so it is robust and parameter-light:
 *
 *   rrf(item) = Σ_lists 1 / (k + rank_in_list(item))
 *
 * A concept query like "auth middleware" that BM25 misses (no literal token
 * overlap with `requireAuth`) can still surface via the vector list, while
 * exact-token queries keep BM25's precision — the union, re-ranked.
 */

export interface RankedItem {
  id: string
}

export interface FusedHit {
  id: string
  rrfScore: number
}

/**
 * Reciprocal Rank Fusion over any number of ranked lists.
 * @param lists Each list is ordered best-first.
 * @param k Damping constant (60 is the canonical default).
 */
export function reciprocalRankFusion(lists: RankedItem[][], k = 60): FusedHit[] {
  const scores = new Map<string, number>()
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!.id
      const contribution = 1 / (k + rank + 1)
      scores.set(id, (scores.get(id) ?? 0) + contribution)
    }
  }
  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
}
