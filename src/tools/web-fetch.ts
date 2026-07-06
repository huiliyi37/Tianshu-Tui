import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Tool, ToolCallParams } from './types.js'
import { fetchCauseDetail } from '../api/error-classifier.js'

const MAX_CONTENT_LENGTH = 50_000
const MAX_REDIRECTS = 5

export interface FetchDeps {
  lookup: (hostname: string) => Promise<{ address: string }>
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}

const defaultDeps: FetchDeps = {
  lookup: dnsLookup,
  fetch: globalThis.fetch.bind(globalThis),
}

let _turndown: any = null

async function getTurndown(): Promise<any> {
  if (!_turndown) {
    const { default: TurndownService } = await import('turndown')
    _turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    })
    _turndown.remove(['script', 'style'])
  }
  return _turndown
}

export async function htmlToMarkdown(html: string): Promise<string> {
  const td = await getTurndown()
  return td.turndown(html)
}

export function isPrivateIP(ip: string): boolean {
  if (isIP(ip) === 4) {
    const octets = ip.split('.').map(Number)
    if (octets[0] === 10) return true
    if (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) return true
    if (octets[0] === 192 && octets[1] === 168) return true
    if (octets[0] === 127) return true
    if (octets[0] === 0) return true
    if (octets[0] === 169 && octets[1] === 254) return true
    return false
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe80')) return true
    return false
  }
  return false
}

export function createWebFetchTool(deps: FetchDeps = defaultDeps): Tool {
  const { lookup, fetch } = deps
  return {
    definition: {
      name: 'web_fetch',
      description: `Fetch content from a URL and return it as text. Useful for reading documentation, API references, or issue pages.
	Returns the page content converted to plain text (HTML tags stripped). Content is truncated to ~50K characters.
	Requires user approval since it makes network requests.`,
      input_schema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch',
          },
        },
        required: ['url'],
      },
    },

    async execute(params: ToolCallParams) {
      const rawUrl = params.input.url as string

      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        return { content: `Invalid URL: ${rawUrl}`, isError: true }
      }

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { content: `Unsupported protocol: ${url.protocol}. Only http and https are allowed.`, isError: true }
      }

      try {
        const { address } = await lookup(url.hostname)
        if (isPrivateIP(address)) {
          return { content: `Access denied: ${url.hostname} resolves to a private/reserved IP (${address})`, isError: true }
        }
      } catch {
        return { content: `Could not resolve hostname: ${url.hostname}`, isError: true }
      }

      try {
        const headers = { 'User-Agent': 'Rivet/0.1 (terminal coding agent)' }

        let currentUrl = rawUrl
        let response: Response | undefined
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          let hopUrl: URL
          try {
            hopUrl = new URL(currentUrl)
          } catch {
            return { content: `Invalid redirect URL: ${currentUrl}`, isError: true }
          }
          if (hopUrl.protocol !== 'http:' && hopUrl.protocol !== 'https:') {
            return { content: `Redirect to unsupported protocol: ${hopUrl.protocol}`, isError: true }
          }
          try {
            const { address } = await lookup(hopUrl.hostname)
            if (isPrivateIP(address)) {
              return { content: `Access denied: ${hopUrl.hostname} resolves to private/reserved IP (${address})`, isError: true }
            }
          } catch {
            return { content: `Could not resolve hostname: ${hopUrl.hostname}`, isError: true }
          }

          const hopController = new AbortController()
          const hopTimeout = setTimeout(() => hopController.abort(), 10_000)
          try {
            response = await fetch(currentUrl, {
              signal: hopController.signal,
              headers,
              redirect: 'manual',
            })
          } finally {
            clearTimeout(hopTimeout)
          }

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location')
            if (!location) {
              return { content: `Redirect ${response.status} with no Location header`, isError: true }
            }
            currentUrl = new URL(location, currentUrl).href
            continue
          }
          break
        }

        if (!response || response.status >= 300) {
          return { content: `Too many redirects (>${MAX_REDIRECTS}) for ${rawUrl}`, isError: true }
        }

        if (!response.ok) {
          return { content: `HTTP ${response.status} ${response.statusText} for ${rawUrl}`, isError: true }
        }

        const contentType = response.headers.get('content-type') ?? ''
        const bodyController = new AbortController()
        const bodyTimeout = setTimeout(() => bodyController.abort(), 15_000)
        let body: string
        try {
          body = await response.text()
        } finally {
          clearTimeout(bodyTimeout)
        }

        let content: string
        if (contentType.includes('text/html')) {
          content = await htmlToMarkdown(body)
        } else {
          content = body
        }

        if (content.length > MAX_CONTENT_LENGTH) {
          content = content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[... truncated at ${MAX_CONTENT_LENGTH} chars, total ${body.length}]`
        }

        return { content: `URL: ${rawUrl}\nStatus: ${response.status}\nContent-Length: ${body.length}\n\n${content}` }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // undici hides the real network failure in err.cause — surface it so
        // the model/user sees "fetch failed: connect ECONNREFUSED ..." instead
        // of an undiagnosable bare "fetch failed".
        const detail = fetchCauseDetail(err)
        const full = detail ? `${message}: ${detail}` : message
        return { content: `Failed to fetch ${rawUrl}: ${full}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

export const WEB_FETCH_TOOL: Tool = createWebFetchTool()
