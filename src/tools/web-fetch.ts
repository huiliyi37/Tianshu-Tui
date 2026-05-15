import type { Tool, ToolCallParams } from './types.js'

const MAX_CONTENT_LENGTH = 50_000

export function htmlToMarkdown(html: string): string {
  let text = html
  text = text.replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, (_, content) => `## ${content}`)
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n\n')
  text = text.replace(/<p[^>]*>/gi, '')
  text = text.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**')
  text = text.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '*$2*')
  text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```')
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return text
}

export const WEB_FETCH_TOOL: Tool = {
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
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)

      const response = await fetch(rawUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Rivet/0.1 (terminal coding agent)' },
      })
      clearTimeout(timeout)

      if (!response.ok) {
        return { content: `HTTP ${response.status} ${response.statusText} for ${rawUrl}`, isError: true }
      }

      const contentType = response.headers.get('content-type') ?? ''
      const body = await response.text()

      let content: string
      if (contentType.includes('text/html')) {
        content = htmlToMarkdown(body)
      } else {
        content = body
      }

      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[... truncated at ${MAX_CONTENT_LENGTH} chars, total ${body.length}]`
      }

      return { content: `URL: ${rawUrl}\nStatus: ${response.status}\nContent-Length: ${body.length}\n\n${content}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Failed to fetch ${rawUrl}: ${message}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
