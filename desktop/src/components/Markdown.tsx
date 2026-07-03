import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { openExternal } from '../lib/open-external'

// U8b — highlight.js is loaded on demand the first time we actually need to
// highlight a code block. This keeps the initial bundle smaller and avoids
// paying the common-language pack cost on screens that never render code.
type Hljs = typeof import('highlight.js/lib/common').default
let hljsPromise: Promise<Hljs> | null = null
function getHljs(): Promise<Hljs> {
  if (!hljsPromise) hljsPromise = import('highlight.js/lib/common').then((m) => m.default)
  return hljsPromise
}

// Conversation Markdown renderer (D1). Renders assistant/user/steer prose as
// GFM Markdown. Syntax highlighting runs ASYNCHRONOUSLY after mount (highlight.js
// via requestIdleCallback) instead of synchronously in the render pass — a long
// reply with many code blocks no longer blocks the main thread on the frame it
// first parses to Markdown. Token colors come from styles.css (.md .hljs-*).
//
// Security: rehype-raw is intentionally NOT enabled — model output is untrusted,
// so raw HTML must never be injected. react-markdown escapes HTML by default.
//
// Links open in the system browser via the opener plugin (Tauri intercepts
// window.open, so we route through openUrl) rather than navigating the app
// shell.

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

async function highlightWithin(root: HTMLElement): Promise<void> {
  const hljs = await getHljs()
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
        if (href) openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

/** Internal file-mention link — clicking opens the file in a side panel. */
function FileMentionLink({ path, onClick, children }: { path: string; onClick?: (p: string) => void; children: React.ReactNode }) {
  return (
    <a
      className="mention-link"
      href={`#file:${path}`}
      onClick={(e) => {
        e.preventDefault()
        onClick?.(path)
      }}
    >
      {children}
    </a>
  )
}

/** U4: code block wrapper with a hover copy button. */
function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const { children, ...rest } = props
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const copy = () => {
    const text = preRef.current?.textContent ?? ''
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="md-pre-wrap">
      <button
        className="md-pre-copy"
        onClick={copy}
        aria-label={copied ? '已复制' : '复制'}
        title={copied ? '已复制' : '复制'}
      >
        {copied ? '✓' : '⎘'}
      </button>
      <pre {...rest} ref={preRef}>{children}</pre>
    </div>
  )
}

/** Pre-process source: convert @file:path tokens into markdown links so
 *  react-markdown renders them as <a> elements we can intercept. Matches both
 *  quoted (@file:"path with spaces") and unquoted (@file:path) forms. */
function linkifyFileMentions(source: string): string {
  return source.replace(/@file:(?:"([^"]+)"|([^\s)]+))/g, (_match, quoted, unquoted) => {
    const path = quoted ?? unquoted
    // Use the basename as the visible label, full path in href.
    const label = path.replace(/.*[/\\]/, '') || path
    return `[📁 ${label}](#file:${path})`
  })
}

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

function MarkdownImpl({ source, highlight = true, onFileClick }: { source: string; highlight?: boolean; onFileClick?: (path: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const huge = source.length > MD_RENDER_MAX

  // Async highlight pass — skipped while streaming (highlight=false) so deltas
  // only re-render the cheap structure; runs once the source settles.
  useEffect(() => {
    if (huge || !highlight) return
    const root = ref.current
    if (!root) return
    const id = scheduleIdle(() => { void highlightWithin(root) })
    return () => cancelIdle(id)
  }, [source, highlight, huge])

  if (huge) {
    return <div className="md md-streaming" ref={ref}>{source}</div>
  }

  const normalized = normalizeMathDelimiters(linkifyFileMentions(source))
  const components = {
    a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
      const { href, children, ...rest } = props
      // Internal file mention link (#file:path) → side panel.
      if (href?.startsWith('#file:')) {
        const path = href.slice(6)
        return <FileMentionLink path={path} onClick={onFileClick}>{children}</FileMentionLink>
      }
      return <ExternalLink href={href} {...rest}>{children}</ExternalLink>
    },
    pre: CodeBlock,
  }
  return (
    <div className="md" ref={ref}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
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
  (a, b) => a.source === b.source && a.highlight === b.highlight && a.onFileClick === b.onFileClick,
)
