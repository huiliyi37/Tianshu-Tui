import { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import hljs from 'highlight.js/lib/core'

// Register only the most common languages to keep the bundle small.
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

/** Highlighting whole files > this many lines is expensive and rarely useful. */
const HIGHLIGHT_MAX_LINES = 5_000

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * highlight.js output is escaped by default, but we feed it into
 * dangerouslySetInnerHTML. Belt-and-suspenders: parse it ourselves and keep
 * only `span` nodes with a `class` attribute, dropping any unexpected tags or
 * event handlers that might slip through.
 */
function sanitizeHighlightedHtml(html: string): string {
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
 * File viewer — renders source code with syntax highlighting and line numbers.
 * Large files are virtualized so only visible rows touch the DOM, and syntax
 * highlighting is disabled past a line threshold to keep rendering responsive.
 * Highlighted HTML is sanitized before injection to avoid XSS.
 */
export function FileViewer(props: {
  content: string
  language: string
  startLine?: number
  highlightLines?: number[]
}) {
  const { content, language, startLine = 1, highlightLines = [] } = props
  const parentRef = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => content.split('\n'), [content])
  const highlightSet = useMemo(() => new Set(highlightLines), [highlightLines])

  const highlighted = useMemo(() => {
    const shouldHighlight =
      language !== 'plaintext' &&
      hljs.getLanguage(language) &&
      lines.length <= HIGHLIGHT_MAX_LINES
    try {
      if (shouldHighlight) {
        return sanitizeHighlightedHtml(hljs.highlight(content, { language }).value)
      }
      return escapeHtml(content)
    } catch {
      return escapeHtml(content)
    }
  }, [content, language, lines.length])

  const highlightedLines = useMemo(() => highlighted.split('\n'), [highlighted])

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 8,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <div ref={parentRef} className="file-viewer">
      <div
        className="file-viewer-code"
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
          padding: 0,
        }}
      >
        {virtualItems.map((virtualRow) => {
          const i = virtualRow.index
          const lineNum = startLine + i
          const isHighlighted = highlightSet.has(lineNum)
          const html = highlightedLines[i] ?? ''
          return (
            <div
              key={virtualRow.key}
              data-index={i}
              ref={virtualizer.measureElement}
              className={`file-line${isHighlighted ? ' highlighted' : ''}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <span className="file-line-num">{lineNum}</span>
              <span
                className="file-line-content"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
