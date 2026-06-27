import React, { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import hljs from 'highlight.js/lib/common'

// Conversation Markdown renderer (D1). Renders assistant/user/steer prose as
// GFM Markdown. Syntax highlighting runs ASYNCHRONOUSLY after mount (highlight.js
// via requestIdleCallback) instead of synchronously in the render pass — a long
// reply with many code blocks no longer blocks the main thread on the frame it
// first parses to Markdown. Token colors come from styles.css (.md .hljs-*).
//
// Security: rehype-raw is intentionally NOT enabled — model output is untrusted,
// so raw HTML must never be injected. react-markdown escapes HTML by default.
//
// Links open in the system browser (Tauri routes window.open externally) rather
// than navigating the app shell.

// Guards: skip highlighting a single oversized code block (cost ∝ length), and
// bypass the whole Markdown pipeline for pathologically large messages to avoid
// main-thread stalls (huge DOM, inline-link regex blowups seen in other tools).
const CODE_HIGHLIGHT_MAX = 20000
const MD_RENDER_MAX = 100000

function scheduleIdle(cb: () => void): number {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
  if (typeof ric === 'function') return ric(cb, { timeout: 500 })
  return setTimeout(cb, 16) as unknown as number
}

function cancelIdle(id: number): void {
  const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
  if (typeof cic === 'function') cic(id)
  else clearTimeout(id)
}

function highlightWithin(root: HTMLElement): void {
  const blocks = root.querySelectorAll<HTMLElement>('pre code:not([data-hl])')
  blocks.forEach((el) => {
    // Mark first so a skipped (oversized) block is never retried on re-render.
    el.dataset.hl = '1'
    if ((el.textContent?.length ?? 0) > CODE_HIGHLIGHT_MAX) return
    try {
      hljs.highlightElement(el)
    } catch {
      // non-fatal — unknown language / detached node
    }
  })
}

function ExternalLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { href, children, ...rest } = props
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) {
          try {
            window.open(href, '_blank', 'noopener,noreferrer')
          } catch {
            // non-fatal — sandboxed contexts may block window.open
          }
        }
      }}
    >
      {children}
    </a>
  )
}

const COMPONENTS = {
  a: ExternalLink,
} as const

// During streaming a fenced code block is often half-open (odd number of ```
// fences). Left as-is, react-markdown swallows the rest of the message into a
// code block until the closing fence streams in, causing a visible flash on
// every delta. Appending a temporary closing fence keeps partial output stable.
// Pure + exported for unit tests; only applied to the in-flight streaming source.
export function closeUnterminatedFence(source: string): string {
  const fences = source.match(/^[ \t]*```/gm)
  if (fences && fences.length % 2 === 1) {
    return `${source}${source.endsWith('\n') ? '' : '\n'}\`\`\``
  }
  return source
}

// remark-math v6 only recognizes `$...$` (inline) and `$$\n...\n$$` (block with
// internal newlines). LaTeX-standard `\[...\]` / `\(...\)` and single-line
// `$$...$$` are NOT parsed. This normalizes all common forms so model output
// renders regardless of which delimiter style the model uses.
// Pure + exported for unit tests.
export function normalizeMathDelimiters(source: string): string {
  return source
    // Block math: \[...\]  →  $$\n...\n$$ (newlines ensure remark-math sees block)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `$$\n${body.trim()}\n$$`)
    // Inline math: \(...\)  →  $...$
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body.trim()}$`)
    // Single-line block $$...$$ on its own line  →  multiline $$ for block detection
    // (remark-math needs newlines inside $$ to classify as block, not inline)
    .replace(/^(\s*)\$\$([^\n$]+)\$\$\s*$/gm, (_, indent: string, body: string) => `${indent}$$\n${indent}${body}\n${indent}$$`)
}

function MarkdownImpl({ source, highlight = true }: { source: string; highlight?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const huge = source.length > MD_RENDER_MAX

  // Async highlight pass — skipped while streaming (highlight=false) so deltas
  // only re-render the cheap structure; runs once the source settles.
  useEffect(() => {
    if (huge || !highlight) return
    const root = ref.current
    if (!root) return
    const id = scheduleIdle(() => highlightWithin(root))
    return () => cancelIdle(id)
  }, [source, highlight, huge])

  if (huge) {
    return <div className="md md-streaming" ref={ref}>{source}</div>
  }

  const normalized = normalizeMathDelimiters(source)
  return (
    <div className="md" ref={ref}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={COMPONENTS}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
}

// Memoize by source + highlight flag — streaming deltas re-render the parent
// frequently; this keeps re-parses limited to actual content/mode changes.
export const Markdown = React.memo(
  MarkdownImpl,
  (a, b) => a.source === b.source && a.highlight === b.highlight,
)
