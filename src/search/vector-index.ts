/**
 * Vector index for semantic code search.
 *
 * Stores one embedding per chunk id and answers nearest-neighbour queries by
 * cosine similarity. Small repositories (the common case) use brute-force
 * cosine, which is fast enough for a few thousand chunks and keeps the
 * implementation dependency-free. The on-disk snapshot lives beside the BM25
 * index in `.rivet/`.
 */

export interface VectorHit {
  id: string
  score: number
}

export interface VectorIndexSnapshot {
  version: number
  providerId: string
  dim: number
  entries: Array<{ id: string; vector: number[] }>
}

const VECTOR_INDEX_VERSION = 1

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate input. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export class VectorIndex {
  private vectors = new Map<string, number[]>()
  private _providerId = ''

  get size(): number { return this.vectors.size }
  get providerId(): string { return this._providerId }
  set providerId(id: string) { this._providerId = id }

  has(id: string): boolean { return this.vectors.has(id) }

  add(id: string, vector: number[]): void {
    this.vectors.set(id, vector)
  }

  remove(id: string): void {
    this.vectors.delete(id)
  }

  /** Remove every vector whose id starts with `${file}:` (chunk id convention). */
  removeFile(file: string): void {
    const prefix = `${file}:`
    for (const id of this.vectors.keys()) {
      if (id.startsWith(prefix)) this.vectors.delete(id)
    }
  }

  clear(): void {
    this.vectors.clear()
  }

  /** Nearest chunks to a query vector by cosine similarity. */
  search(queryVector: number[], limit = 10): VectorHit[] {
    if (this.vectors.size === 0 || queryVector.length === 0) return []
    const hits: VectorHit[] = []
    for (const [id, vec] of this.vectors) {
      const score = cosineSimilarity(queryVector, vec)
      if (score > 0) hits.push({ id, score })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  toSnapshot(): VectorIndexSnapshot {
    const entries = [...this.vectors.entries()].map(([id, vector]) => ({ id, vector }))
    return {
      version: VECTOR_INDEX_VERSION,
      providerId: this._providerId,
      dim: entries[0]?.vector.length ?? 0,
      entries,
    }
  }

  /** Load from snapshot, but only if the provider matches (dimensions/model). */
  loadSnapshot(snapshot: VectorIndexSnapshot, expectedProviderId: string): boolean {
    if (snapshot.version !== VECTOR_INDEX_VERSION) return false
    if (snapshot.providerId !== expectedProviderId) return false
    this.clear()
    this._providerId = snapshot.providerId
    for (const e of snapshot.entries) this.vectors.set(e.id, e.vector)
    return true
  }
}
