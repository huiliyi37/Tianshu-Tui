/**
 * Pluggable embedding provider for true semantic (vector) code search.
 *
 * The default backend calls an OpenAI-compatible `/embeddings` endpoint using
 * the configured provider's base URL + key (DeepSeek/OpenAI/etc). When no key
 * or endpoint is available — or the call fails — the provider reports itself
 * unavailable and search degrades to BM25. So embeddings are a strict upgrade:
 * they never make the offline path worse.
 *
 * Custom/local providers (transformers.js, fastembed, a local server) can be
 * dropped in by implementing EmbeddingProvider and passing it where the index
 * is constructed.
 */

export interface EmbeddingProvider {
  /** Stable id for cache invalidation when the model changes. */
  readonly id: string
  /** True when embeddings can actually be produced (key/endpoint present). */
  isAvailable(): boolean
  /** Embed a batch of texts. Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>
}

export interface RemoteEmbeddingOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Max texts per request. */
  batchSize?: number
}

/** OpenAI-compatible `/embeddings` provider. */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  private baseUrl: string
  private apiKey: string
  private model: string
  private fetchImpl: typeof fetch
  private batchSize: number

  constructor(opts: RemoteEmbeddingOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.batchSize = Math.max(1, opts.batchSize ?? 64)
    this.id = `remote:${this.model}`
  }

  isAvailable(): boolean {
    return Boolean(this.baseUrl && this.apiKey && this.model)
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      })
      if (!res.ok) {
        throw new Error(`embeddings request failed: ${res.status}`)
      }
      const json = await res.json() as { data?: Array<{ embedding: number[]; index?: number }> }
      const data = json.data ?? []
      // Preserve input order (API returns an `index` field).
      const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      for (const d of ordered) out.push(d.embedding)
    }
    return out
  }
}

/** A provider that never produces vectors — forces BM25-only search. */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'null'
  isAvailable(): boolean { return false }
  async embed(): Promise<number[][]> { return [] }
}

export interface EmbeddingConfig {
  baseUrl?: string
  apiKey?: string
  model?: string
  fetchImpl?: typeof fetch
}

/**
 * Build the default embedding provider from explicit config, falling back to
 * env vars, then to a null (offline) provider. Resolution order:
 *   1. explicit opts
 *   2. RIVET_EMBEDDING_{BASE_URL,API_KEY,MODEL}
 *   3. common provider keys (OPENAI_API_KEY / DEEPSEEK_API_KEY) with sane defaults
 */
export function createEmbeddingProvider(opts: EmbeddingConfig = {}): EmbeddingProvider {
  const env = process.env
  if (env.RIVET_NO_EMBEDDINGS === '1') return new NullEmbeddingProvider()

  const baseUrl = opts.baseUrl
    ?? env.RIVET_EMBEDDING_BASE_URL
    ?? (env.OPENAI_API_KEY ? 'https://api.openai.com/v1' : undefined)
    ?? (env.DEEPSEEK_API_KEY ? 'https://api.deepseek.com/v1' : undefined)

  const apiKey = opts.apiKey
    ?? env.RIVET_EMBEDDING_API_KEY
    ?? env.OPENAI_API_KEY
    ?? env.DEEPSEEK_API_KEY

  const model = opts.model
    ?? env.RIVET_EMBEDDING_MODEL
    ?? 'text-embedding-3-small'

  if (!baseUrl || !apiKey || !model) return new NullEmbeddingProvider()
  return new RemoteEmbeddingProvider({ baseUrl, apiKey, model, fetchImpl: opts.fetchImpl })
}
