import { useState } from 'react'

// Collapsible tool call / result (P2). Keeps the conversation readable: a one-line
// header (tool name + first-line preview) that expands to the full input/output.
export function ToolBlock(props: { title: string; body: string; isError?: boolean }) {
  const { title, body, isError } = props
  const [open, setOpen] = useState(false)
  const firstLine = body.split('\n', 1)[0] ?? ''
  const preview = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine

  return (
    <div className={`tool-block ${isError ? 'err' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden>▸</span>
        <span className="tool-name">{title}</span>
        {!open && <span className="tool-preview">{preview}</span>}
      </button>
      {open && <pre className="tool-body">{body}</pre>}
    </div>
  )
}
