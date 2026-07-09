import { lookup as dnsLookup } from 'node:dns/promises'
import { resolveAndAssertPublic, type LookupFn } from './ssrf.js'

export interface HttpFetchDeps {
  lookup?: LookupFn
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

export interface HttpFetchOptions {
  timeoutMs?: number
  maxResponseBytes?: number
  maxRedirects?: number
  userAgent?: string
}

export interface HttpFetchResult {
  status: number
  finalUrl: string
  contentType: string
  bytes: Uint8Array
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 10_485_760
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT = 'Tianshu/1.0 (terminal coding agent)'

export async function httpFetchGuarded(
  url: string,
  deps: HttpFetchDeps = {},
  opts: HttpFetchOptions = {},
): Promise<HttpFetchResult> {
  const lookup = deps.lookup ?? dnsLookup
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}. Only http and https are allowed.`)
  }

  // Pre-flight initial hostname.
  await resolveAndAssertPublic(parsed.hostname, lookup)

  const headers: Record<string, string> = { 'User-Agent': userAgent }
  let currentUrl = parsed.href
  let response: Response | undefined

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let hopUrl: URL
    try {
      hopUrl = new URL(currentUrl)
    } catch {
      throw new Error(`Invalid redirect URL: ${currentUrl}`)
    }
    if (hopUrl.protocol !== 'http:' && hopUrl.protocol !== 'https:') {
      throw new Error(`Redirect to unsupported protocol: ${hopUrl.protocol}`)
    }
    await resolveAndAssertPublic(hopUrl.hostname, lookup)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        headers,
        redirect: 'manual',
      })
    } finally {
      clearTimeout(timeout)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new Error(`Redirect ${response.status} with no Location header`)
      }
      currentUrl = new URL(location, currentUrl).href
      continue
    }
    break
  }

  if (!response || (response.status >= 300 && response.status < 400)) {
    throw new Error(`Too many redirects (>${maxRedirects}) for ${url}`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  const bytes = await readBody(response, maxBytes, timeoutMs)

  return {
    status: response.status,
    finalUrl: currentUrl,
    contentType,
    bytes,
  }
}

async function readBody(response: Response, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const timeoutPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error('Body read timeout'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) onAbort()
  })

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeoutPromise])
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel(`response body exceeds ${maxBytes} bytes`)
          throw new Error(`Response body exceeds maximum allowed size (${maxBytes} bytes)`)
        }
        chunks.push(value)
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    throw err
  } finally {
    clearTimeout(timeout)
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
