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

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = detectCharset(bytes, contentType)
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

function detectCharset(bytes: Uint8Array, contentType: string): string {
  const header = contentType
    .match(/charset=([^;]+)/i)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  if (header) return header.toLowerCase()

  if (contentType.includes('text/html')) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 1024))
    const meta = head.match(/<meta[^>]+charset=["']?([^"';>\s]+)/i)?.[1]
    if (meta) return meta.toLowerCase()
  }

  return 'utf-8'
}

const NOISE_TAGS = ['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside']

export function extractMainContent(html: string): string {
  const region = extractRegion(html, 'main') ?? extractRegion(html, 'article')
  const source = region ?? html

  const noisePattern = new RegExp(`<(${NOISE_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`, 'gi')
  const stripped = source.replace(noisePattern, '')
  return stripped.trim()
}

function extractRegion(html: string, tag: string): string | undefined {
  const openRegex = new RegExp(`<${tag}\\b[^>]*>`, 'i')
  const openMatch = html.match(openRegex)
  if (!openMatch) return undefined

  const start = openMatch.index! + openMatch[0].length
  const openScanner = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
  const closeScanner = new RegExp(`</${tag}>`, 'gi')

  let depth = 1
  let idx = start
  while (depth > 0) {
    openScanner.lastIndex = idx
    closeScanner.lastIndex = idx
    const nextOpen = openScanner.exec(html)
    const nextClose = closeScanner.exec(html)
    if (!nextClose) return undefined

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++
      idx = nextOpen.index + nextOpen[0].length
    } else {
      depth--
      if (depth === 0) return html.slice(start, nextClose.index)
      idx = nextClose.index + nextClose[0].length
    }
  }

  return undefined
}
