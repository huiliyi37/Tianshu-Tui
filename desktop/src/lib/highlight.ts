import hljs from 'highlight.js/lib/core'

// Register only the most common languages to keep the bundle small. This is the
// same singleton instance used by FileViewer — registering here is idempotent so
// DiffView can be rendered without FileViewer having been loaded first.
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('yaml', yaml)

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  vue: 'html',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
}

/** Map a file path to a registered highlight.js language, or 'plaintext'. */
export function languageFromPath(path: string | undefined): string {
  if (!path) return 'plaintext'
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANGUAGE[ext] ?? 'plaintext'
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * highlight.js emits escaped output, but we inject it via dangerouslySetInnerHTML.
 * Belt-and-suspenders: keep only `span[class]` nodes, dropping any unexpected
 * tags or attributes that could carry script/event handlers.
 */
export function sanitizeHighlightedHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return escapeHtml(html)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const walk = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return node.cloneNode()
    if (node.nodeType !== Node.ELEMENT_NODE) return null
    const el = node as Element
    if (el.tagName.toLowerCase() !== 'span') return null
    const cls = el.getAttribute('class')
    const span = doc.createElement('span')
    if (cls) span.setAttribute('class', cls)
    for (const child of el.childNodes) {
      const cleaned = walk(child)
      if (cleaned) span.appendChild(cleaned)
    }
    return span
  }
  const frag = doc.createDocumentFragment()
  for (const child of doc.body.childNodes) {
    const cleaned = walk(child)
    if (cleaned) frag.appendChild(cleaned)
  }
  const div = doc.createElement('div')
  div.appendChild(frag)
  return div.innerHTML
}

/**
 * Highlight a single line of code. Per-line highlighting loses multi-line
 * context (e.g. block comments) but is the standard trade-off for diff views,
 * where each row is rendered independently. Returns sanitized HTML.
 */
export function highlightLine(content: string, language: string): string {
  if (!content) return ''
  if (language === 'plaintext' || !hljs.getLanguage(language)) return escapeHtml(content)
  try {
    return sanitizeHighlightedHtml(hljs.highlight(content, { language }).value)
  } catch {
    return escapeHtml(content)
  }
}
