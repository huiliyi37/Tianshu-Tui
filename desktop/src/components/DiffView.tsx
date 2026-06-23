import { useState, useMemo } from 'react'

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  oldNo: number | null
  newNo: number | null
  content: string
}

interface Hunk {
  header: string
  lines: DiffLine[]
}

/**
 * Parse a unified diff into hunks with line metadata. Each line is typed as
 * add/del/ctx/hunk/meta with old/new line numbers for side-by-side rendering.
 */
function parseDiff(raw: string): { fileLines: string[]; hunks: Hunk[] } {
  const lines = raw.split('\n')
  const fileLines: string[] = []
  const hunks: Hunk[] = []
  let currentHunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of lines) {
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      fileLines.push(line)
      continue
    }
    if (line.startsWith('@@')) {
      // Start a new hunk — parse line numbers from @@ -a,b +c,d @@
      const match = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      if (match) {
        oldNo = parseInt(match[1]!, 10)
        newNo = parseInt(match[2]!, 10)
      } else {
        // Malformed @@ header — reset to avoid stale line numbers from previous hunk
        oldNo = 0
        newNo = 0
      }
      currentHunk = { header: line, lines: [] }
      hunks.push(currentHunk)
      currentHunk.lines.push({ type: 'hunk', oldNo: null, newNo: null, content: line })
      continue
    }
    if (!currentHunk) {
      fileLines.push(line)
      continue
    }
    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, content: line.slice(1) })
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, content: line.slice(1) })
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, content: line.slice(1) })
    } else {
      currentHunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, content: line })
    }
  }
  return { fileLines, hunks }
}

/**
 * Unified or side-by-side diff renderer with hunk awareness.
 * Upgrades the basic line-coloring DiffView with:
 * - Hunk-grouped sections with @@ headers
 * - Toggle between unified and side-by-side view
 * - Proper line numbering
 */
export function DiffView(props: { raw: string }) {
  const { raw } = props
  const [sideBySide, setSideBySide] = useState(false)

  const parsed = useMemo(() => parseDiff(raw), [raw])
  const hasHunks = parsed.hunks.length > 0

  // Fallback to simple rendering if no hunks detected (non-diff content)
  if (!hasHunks) {
    const lines = raw.split('\n')
    return (
      <pre className="diff">
        {lines.map((line, i) => {
          let cls = 'diff-ctx'
          if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-add'
          else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-del'
          else if (line.startsWith('@@')) cls = 'diff-hunk'
          else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta'
          return <div key={i} className={cls}>{line || ' '}</div>
        })}
      </pre>
    )
  }

  return (
    <div className="diff-hunked">
      <div className="diff-toolbar">
        <button
          className={`diff-toggle ${sideBySide ? 'active' : ''}`}
          onClick={() => setSideBySide((v) => !v)}
        >
          {sideBySide ? '双列' : '单列'}
        </button>
      </div>
      {sideBySide ? (
        <SideBySide hunks={parsed.hunks} />
      ) : (
        <Unified hunks={parsed.hunks} />
      )}
    </div>
  )
}

function Unified({ hunks }: { hunks: Hunk[] }) {
  return (
    <div className="diff-unified">
      {hunks.map((h, hi) => (
        <div key={hi} className="diff-hunk-group">
          {h.lines.map((line, li) => (
            <div key={li} className={`diff-row diff-${line.type}`}>
              <span className="diff-ln-old">{line.oldNo ?? ''}</span>
              <span className="diff-ln-new">{line.newNo ?? ''}</span>
              <span className="diff-sign">
                {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
              </span>
              <span className="diff-text">{line.content || ' '}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function SideBySide({ hunks }: { hunks: Hunk[] }) {
  return (
    <div className="diff-split">
      {hunks.map((h, hi) => {
        // Split lines into left (old) and right (new) columns
        const left: DiffLine[] = []
        const right: DiffLine[] = []
        for (const line of h.lines) {
          if (line.type === 'hunk') continue
          if (line.type === 'add') {
            left.push({ type: 'ctx', oldNo: null, newNo: null, content: '' })
            right.push(line)
          } else if (line.type === 'del') {
            left.push(line)
            right.push({ type: 'ctx', oldNo: null, newNo: null, content: '' })
          } else {
            left.push(line)
            right.push({ ...line })
          }
        }
        return (
          <div key={hi} className="diff-hunk-group diff-hunk-split">
            <div className="diff-split-header">{h.header}</div>
            <div className="diff-split-cols">
              <div className="diff-split-col">
                {left.map((line, li) => (
                  <div key={li} className={`diff-row diff-${line.type}`}>
                    <span className="diff-ln">{line.oldNo ?? ''}</span>
                    <span className="diff-text">{line.content || ' '}</span>
                  </div>
                ))}
              </div>
              <div className="diff-split-col">
                {right.map((line, li) => (
                  <div key={li} className={`diff-row diff-${line.type}`}>
                    <span className="diff-ln">{line.newNo ?? ''}</span>
                    <span className="diff-text">{line.content || ' '}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
