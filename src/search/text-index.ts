/**
 * Lightweight BM25 text index for semantic-ish code search.
 *
 * Pure TypeScript — no external embedding models. Good enough for
 * "find code related to authentication" within a project.
 */

export interface IndexedChunk {
  id: string
  file: string
  startLine: number
  endLine: number
  text: string
  terms: Map<string, number>
  length: number
}

export interface SearchHit {
  id: string
  file: string
  startLine: number
  endLine: number
  text: string
  score: number
}

const TOKEN_RE = /[a-zA-Z_][a-zA-Z0-9_]{1,}|[\u4e00-\u9fff]+/g

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(TOKEN_RE)) {
    tokens.push(match[0]!)
  }
  return tokens
}

function termFreq(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  return freq
}

export class BM25Index {
  private chunks: IndexedChunk[] = []
  private df = new Map<string, number>()
  private avgLength = 0
  private readonly k1 = 1.5
  private readonly b = 0.75

  get size(): number {
    return this.chunks.length
  }

  addChunk(file: string, startLine: number, endLine: number, text: string): void {
    const tokens = tokenize(text)
    const terms = termFreq(tokens)
    const id = `${file}:${startLine}-${endLine}`

    for (const term of terms.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1)
    }

    this.chunks.push({ id, file, startLine, endLine, text, terms, length: tokens.length })
    this.avgLength = this.chunks.reduce((s, c) => s + c.length, 0) / Math.max(1, this.chunks.length)
  }

  search(query: string, limit = 10): SearchHit[] {
    const qTerms = tokenize(query)
    if (qTerms.length === 0 || this.chunks.length === 0) return []

    const N = this.chunks.length
    const scores: SearchHit[] = []

    for (const chunk of this.chunks) {
      let score = 0
      for (const term of qTerms) {
        const tf = chunk.terms.get(term) ?? 0
        if (tf === 0) continue
        const df = this.df.get(term) ?? 0
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * chunk.length / this.avgLength))
        score += idf * norm
      }
      if (score > 0) {
        scores.push({
          id: chunk.id,
          file: chunk.file,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text.slice(0, 500),
          score,
        })
      }
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  clear(): void {
    this.chunks = []
    this.df.clear()
    this.avgLength = 0
  }

  /** Remove all chunks belonging to a file, updating DF counts. */
  removeFileChunks(file: string): number {
    const before = this.chunks.length
    const removed: IndexedChunk[] = []

    this.chunks = this.chunks.filter(chunk => {
      if (chunk.file === file) {
        removed.push(chunk)
        return false
      }
      return true
    })

    // Decrement DF for terms in removed chunks
    for (const chunk of removed) {
      for (const term of chunk.terms.keys()) {
        const current = this.df.get(term)
        if (current !== undefined) {
          if (current <= 1) this.df.delete(term)
          else this.df.set(term, current - 1)
        }
      }
    }

    // Update avgLength
    if (this.chunks.length > 0) {
      this.avgLength = this.chunks.reduce((s, c) => s + c.length, 0) / this.chunks.length
    } else {
      this.avgLength = 0
    }

    return before - this.chunks.length
  }

  /** Check if index has any chunks for a given file. */
  hasFile(file: string): boolean {
    return this.chunks.some(c => c.file === file)
  }

  /** Export lightweight chunk refs for serialization (excludes terms Map). */
  getChunkRefs(): Array<{ file: string; startLine: number; endLine: number; text: string }> {
    return this.chunks.map(c => ({ file: c.file, startLine: c.startLine, endLine: c.endLine, text: c.text }))
  }
}

/** Split file content into overlapping line-based chunks for indexing. */
export function chunkFileContent(content: string, chunkLines = 40, overlap = 8): string[] {
  const lines = content.split('\n')
  const chunks: string[] = []
  for (let i = 0; i < lines.length; i += chunkLines - overlap) {
    chunks.push(lines.slice(i, i + chunkLines).join('\n'))
    if (i + chunkLines >= lines.length) break
  }
  return chunks.filter(c => c.trim().length > 0)
}
