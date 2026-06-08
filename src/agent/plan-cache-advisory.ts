export const PLAN_CACHE_ADVISORY_MAX_CHARS = 800

const NOTICE = 'Informational only — not auto-executed.'

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function stripNotice(text: string): string {
  return text
    .replaceAll('(Informational only — not auto-executed.)', '')
    .replaceAll(NOTICE, '')
    .trim()
}

function fitEscaped(raw: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  let out = ''
  for (const char of raw) {
    const escaped = escapeXml(char)
    if (out.length + escaped.length > maxChars) {
      const trimmed = out.trimEnd()
      return trimmed.length < maxChars ? `${trimmed}…` : trimmed
    }
    out += escaped
  }
  return out.trimEnd()
}

export function renderPlanCacheAdvisory(
  suggestion: string | null | undefined,
  maxChars = PLAN_CACHE_ADVISORY_MAX_CHARS,
): string | null {
  const normalized = stripNotice(suggestion ?? '')
  if (!normalized) return null

  const open = '<plan-cache-advisory>\n'
  const close = '\n</plan-cache-advisory>'
  const notice = escapeXml(NOTICE)
  const bodyBudget = Math.max(0, maxChars - open.length - close.length - notice.length - 1)
  const body = fitEscaped(normalized, bodyBudget)
  const content = body ? `${body}\n${notice}` : notice
  const rendered = `${open}${content}${close}`

  return rendered.length <= maxChars
    ? rendered
    : `${open}${notice}${close}`.slice(0, maxChars)
}
