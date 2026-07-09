import { lookup as dnsLookup } from 'node:dns/promises'
import type { Tool, ToolCallParams } from '../types.js'
import { fetchCauseDetail } from '../../api/error-classifier.js'
import { httpFetchGuarded, type HttpFetchDeps, type HttpFetchOptions } from '../net/http-fetch.js'
import { SSRFError } from '../net/ssrf.js'
import { decodeBody, extractMainContent, htmlToMarkdown } from './extract.js'

export interface FetchDeps extends HttpFetchDeps {}
export interface WebFetchOptions extends HttpFetchOptions {
  extractMainContent?: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 10_485_760
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT = 'Tianshu/1.0 (terminal coding agent)'
const DEFAULT_EXTRACT_MAIN = true

const BINARY_CONTENT_TYPE_PREFIXES = [
  'image/',
  'application/pdf',
  'application/octet-stream',
  'video/',
  'audio/',
  'font/',
]

const defaultDeps: FetchDeps = {
  lookup: dnsLookup,
  fetch: globalThis.fetch.bind(globalThis),
}

export function createWebFetchTool(deps: FetchDeps = defaultDeps, opts: WebFetchOptions = {}): Tool {
  const options = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: opts.maxResponseBytes ?? DEFAULT_MAX_BYTES,
    maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    userAgent: opts.userAgent ?? DEFAULT_USER_AGENT,
  }
  const extractMainContentEnabled = opts.extractMainContent ?? DEFAULT_EXTRACT_MAIN

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
        const { status, contentType, bytes } = await httpFetchGuarded(rawUrl, deps, options)

        if (status >= 400) {
          return { content: `HTTP ${status} for ${rawUrl}`, isError: true }
        }

        const contentTypeLower = contentType.toLowerCase()
        if (BINARY_CONTENT_TYPE_PREFIXES.some(prefix => contentTypeLower.includes(prefix))) {
          return {
            content: `Binary content (${contentType}) is not returned as text. Use import_resource to download this URL.`,
            isError: true,
          }
        }

        const body = decodeBody(bytes, contentType)

        let content: string
        if (contentTypeLower.includes('text/html')) {
          const html = extractMainContentEnabled ? extractMainContent(body) : body
          content = await htmlToMarkdown(html)
        } else {
          content = body
        }

        return { content: `URL: ${rawUrl}\nStatus: ${status}\nContent-Length: ${bytes.length}\n\n${content}` }
      } catch (err) {
        if (err instanceof SSRFError) {
          return { content: err.message, isError: true }
        }
        const message = err instanceof Error ? err.message : String(err)
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
