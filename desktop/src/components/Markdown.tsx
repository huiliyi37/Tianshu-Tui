import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

// Conversation Markdown renderer (D1). Renders assistant/user/steer prose as
// GFM Markdown with synchronous code highlighting (highlight.js via rehype).
//
// Security: rehype-raw is intentionally NOT enabled — model output is untrusted,
// so raw HTML must never be injected. react-markdown escapes HTML by default.
//
// Links open in the system browser (Tauri routes window.open externally) rather
// than navigating the app shell.

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

function MarkdownImpl({ source }: { source: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

// Memoize by source text — streaming deltas re-render the parent frequently;
// this keeps re-parses limited to actual text changes.
export const Markdown = React.memo(MarkdownImpl, (a, b) => a.source === b.source)
