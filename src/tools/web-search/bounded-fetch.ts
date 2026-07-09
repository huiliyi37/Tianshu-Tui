import type { SearchFetch } from './types.js'

/** Default response-body cap for search backends. Search responses (HTML SERP
 *  or JSON) are small; anything past this is almost certainly hostile or
 *  malformed and must not be buffered unbounded into the heap. */
export const DEFAULT_MAX_SEARCH_BYTES = 8 * 1024 * 1024 // 8MB

/**
 * Wrap a fetch implementation so the response body is read through a streaming
 * size cap. Backends call `response.text()` / `response.json()` directly, so we
 * fully read the (already content-decoded) body stream up to `maxBytes`, abort
 * if it overflows, and hand back a fresh Response backed by the buffered bytes.
 * Status/statusText/headers are preserved so `response.ok` and content-type
 * checks behave identically; the stale content-encoding/length headers are
 * dropped because the body is already decoded and re-materialised.
 *
 * Only the production (global) fetch is wrapped — injected test fetches return
 * small synthetic responses and stay untouched.
 */
export function boundedSearchFetch(fetchImpl: SearchFetch, maxBytes = DEFAULT_MAX_SEARCH_BYTES): SearchFetch {
  return async (url, init) => {
    const res = await fetchImpl(url, init)
    if (!res.body) return res

    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) {
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel().catch(() => {})
            throw new Error(`search response body exceeded ${maxBytes}-byte cap`)
          }
          chunks.push(Buffer.from(value))
        }
      }
    } finally {
      try { reader.releaseLock() } catch { /* stream already released */ }
    }

    const headers = new Headers(res.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    return new Response(Buffer.concat(chunks, total), {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  }
}
