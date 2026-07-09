import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent } from 'undici'
import { isPrivateIP, resolveAndAssertPublic, SSRFError, type LookupFn } from './ssrf.js'

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

/** Default on; set RIVET_FETCH_PIN=0 / false to fall back to undici's own DNS. */
export function isConnectionPinningEnabled(): boolean {
  const v = process.env.RIVET_FETCH_PIN
  return v !== '0' && v !== 'false'
}

type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void

/**
 * Build a DNS lookup that always resolves to the pre-validated public IP,
 * ignoring the hostname it is called with. This is the anti-rebinding pin:
 * undici connects to the exact address we SSRF-checked instead of resolving
 * the name a second time (which an attacker could flip to a private IP between
 * our check and the socket connect). Exported for unit testing without sockets.
 */
export function buildPinnedLookup(address: string, family: number | undefined): PinnedLookup {
  const fam: 4 | 6 = family === 6 ? 6 : 4
  return (hostname, options, callback) => {
    // Defence in depth: never hand a private IP to the socket layer.
    if (isPrivateIP(address)) {
      callback(new SSRFError(hostname, address) as unknown as NodeJS.ErrnoException, '', 0)
      return
    }
    if (options && typeof options === 'object' && (options as { all?: boolean }).all) {
      callback(null, [{ address, family: fam }])
    } else {
      callback(null, address, fam)
    }
  }
}

/** Per-request undici dispatcher whose connections are pinned to `address`. */
function createPinnedDispatcher(address: string, family: number | undefined): Agent {
  return new Agent({ connect: { lookup: buildPinnedLookup(address, family) as never } })
}

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

  // Connection pinning only applies to the real (undici) network path. When a
  // caller injects a custom fetch (tests, or a non-undici transport) the
  // dispatcher is meaningless, so we skip it.
  const pin = isConnectionPinningEnabled() && !deps.fetch

  const headers: Record<string, string> = { 'User-Agent': userAgent }
  let currentUrl = parsed.href
  let response: Response | undefined
  // Dispatcher of the terminal (non-redirect) response, kept alive until its
  // streaming body has been fully read, then destroyed in the outer finally.
  let activeDispatcher: Agent | undefined

  try {
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
      const resolved = await resolveAndAssertPublic(hopUrl.hostname, lookup)
      const dispatcher = pin ? createPinnedDispatcher(resolved.address, resolved.family) : undefined

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      const init: RequestInit = {
        signal: controller.signal,
        headers,
        redirect: 'manual',
      }
      // `dispatcher` is an undici extension not present in the DOM RequestInit
      // type; the real (undici) global fetch honours it, mock fetches ignore it.
      if (dispatcher) (init as { dispatcher?: unknown }).dispatcher = dispatcher
      try {
        response = await fetchImpl(currentUrl, init)
      } catch (err) {
        if (dispatcher) await dispatcher.destroy().catch(() => {})
        throw err
      } finally {
        clearTimeout(timeout)
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        // Release this hop's connection before following the redirect.
        try { await response.body?.cancel() } catch { /* ignore */ }
        if (dispatcher) await dispatcher.destroy().catch(() => {})
        if (!location) {
          throw new Error(`Redirect ${response.status} with no Location header`)
        }
        currentUrl = new URL(location, currentUrl).href
        continue
      }

      // Terminal response — its body is read below; keep the dispatcher alive.
      activeDispatcher = dispatcher
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
  } finally {
    if (activeDispatcher) await activeDispatcher.destroy().catch(() => {})
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
