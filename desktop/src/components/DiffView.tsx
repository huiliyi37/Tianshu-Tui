import { useState, useMemo } from 'react'
import type { LineComment } from '../runtime/types'

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  oldNo: number | null
  newNo: number | null
  content: string
  /** File path this line belongs to (parsed from +++ b/path or diff --git header).
   *  Lets line-level comments anchor on (file, oldLine, newLine) uniquely. */
  file?: string
}

interface Hunk {
  header: string
  lines: DiffLine[]
}

/** Stable anchor key for a diff line, used to match LineComment positions. */
function lineAnchor(line: DiffLine): string {
  const f = line.file ?? ''
  return `${f}:${line.oldNo ?? ''}:${line.newNo ?? ''}`
}

/** Extract the file path from a unified-diff header line.
 *  Handles `+++ b/path`, `+++ /dev/null`, and `diff --git a/x b/y`. */
function parseFileFromHeader(line: string): string | undefined {
  if (line.startsWith('+++ ')) {
    const rest = line.slice(4)
    // strip optional leading "b/" prefix
    if (rest === '/dev/null') return undefined
    return rest.replace(/^b\//, '')
  }
  if (line.startsWith('diff --git ')) {
    // diff --git a/foo b/foo → take the second path
    const m = line.match(/^diff --git \S+ b\/(.+)$/)
    if (m) return m[1]
  }
  return undefined
}

/**
 * Parse a unified diff into hunks with line metadata. Each line is typed as
 * add/del/ctx/hunk/meta with old/new line numbers for side-by-side rendering.
 * File context is propagated to every content line so line-level comments can
 * anchor on (file, oldLine, newLine) uniquely across multi-file diffs.
 */
function parseDiff(raw: string): { fileLines: string[]; hunks: Hunk[] } {
  const lines = raw.split('\n')
  const fileLines: string[] = []
  const hunks: Hunk[] = []
  let currentHunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  let currentFile: string | undefined

  for (const line of lines) {
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      fileLines.push(line)
      const f = parseFileFromHeader(line)
      if (f) currentFile = f
      continue
    }
    if (line.startsWith('@@')) {
      // Start a new hunk — parse line numbers from @@ -a,b +c,d @@
      const match = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      if (match) {
        oldNo = parseInt(match[1]!, 10)
        newNo = parseInt(match[2]!, 10)
      } else {
        oldNo = 0
        newNo = 0
      }
      currentHunk = { header: line, lines: [] }
      hunks.push(currentHunk)
      currentHunk.lines.push({ type: 'hunk', oldNo: null, newNo: null, content: line, file: currentFile })
      continue
    }
    if (!currentHunk) {
      fileLines.push(line)
      continue
    }
    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, content: line.slice(1), file: currentFile })
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, content: line.slice(1), file: currentFile })
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, content: line.slice(1), file: currentFile })
    } else {
      currentHunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, content: line, file: currentFile })
    }
  }
  return { fileLines, hunks }
}

export interface DiffViewProps {
  raw: string
  /** Existing line-level comments to render as markers/bubbles. */
  comments?: LineComment[]
  /** Called when the user submits a line-level comment on a row. */
  onLineComment?: (anchor: { file: string; oldLine?: number; newLine?: number }, text: string) => void
}

/**
 * Unified or side-by-side diff renderer with hunk awareness and optional
 * line-level commenting. Line rows expose a hover "评论" affordance that opens
 * an inline textarea; submitted comments route through `onLineComment`.
 */
export function DiffView(props: DiffViewProps) {
  const { raw, comments, onLineComment } = props
  const [sideBySide, setSideBySide] = useState(false)
  // map anchor-key → list of comments, for marker/bubble rendering
  const commentMap = useMemo(() => {
    const m = new Map<string, LineComment[]>()
    for (const c of comments ?? []) {
      const k = `${c.file}:${c.oldLine ?? ''}:${c.newLine ?? ''}`
      const arr = m.get(k) ?? []
      arr.push(c)
      m.set(k, arr)
    }
    return m
  }, [comments])

  const parsed = useMemo(() => parseDiff(raw), [raw])
  const hasHunks = parsed.hunks.length > 0
  const interactive = Boolean(onLineComment)

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
        <SideBySide hunks={parsed.hunks} commentMap={commentMap} interactive={interactive} onLineComment={onLineComment} />
      ) : (
        <Unified hunks={parsed.hunks} commentMap={commentMap} interactive={interactive} onLineComment={onLineComment} />
      )}
    </div>
  )
}

/** A single diff row with optional line-level comment affordance. */
function DiffRow({
  line,
  comments,
  interactive,
  onLineComment,
}: {
  line: DiffLine
  comments?: LineComment[]
  interactive: boolean
  onLineComment?: DiffViewProps['onLineComment']
}) {
  const [drafting, setDrafting] = useState(false)
  const [draft, setDraft] = useState('')
  const canComment = interactive && (line.type === 'add' || line.type === 'del' || line.type === 'ctx')

  const submit = () => {
    if (!draft.trim() || !onLineComment) return
    onLineComment(
      { file: line.file ?? '', oldLine: line.oldNo ?? undefined, newLine: line.newNo ?? undefined },
      draft.trim(),
    )
    setDraft('')
    setDrafting(false)
  }

  return (
    <>
      <div className={`diff-row diff-${line.type} ${comments?.length ? 'has-comment' : ''}`}>
        <span className="diff-ln-old">{line.oldNo ?? ''}</span>
        <span className="diff-ln-new">{line.newNo ?? ''}</span>
        <span className="diff-sign">
          {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
        </span>
        <span className="diff-text">{line.content || ' '}</span>
        {canComment && !drafting && (
          <button
            className="diff-row-comment-btn"
            title="评论此行"
            onClick={() => setDrafting(true)}
          >
            {comments?.length ? `💬${comments.length}` : '＋'}
          </button>
        )}
        {comments?.length ? <span className="diff-row-mark">●</span> : null}
      </div>
      {comments?.map((c, i) => (
        <div key={`cmt-${i}`} className="diff-line-comment">
          <span className="diff-line-comment-loc">L{c.newLine ?? c.oldLine}</span>
          <span>{c.comment}</span>
        </div>
      ))}
      {drafting && (
        <div className="diff-line-draft">
          <textarea
            autoFocus
            value={draft}
            placeholder={`评论 ${line.file}:${line.newNo ?? line.oldNo}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              if (e.key === 'Escape') { setDrafting(false); setDraft('') }
            }}
          />
          <div className="diff-line-draft-actions">
            <button className="btn ghost sm" onClick={() => { setDrafting(false); setDraft('') }}>取消</button>
            <button className="btn sm" disabled={!draft.trim()} onClick={submit}>提交</button>
          </div>
        </div>
      )}
    </>
  )
}

function Unified({
  hunks,
  commentMap,
  interactive,
  onLineComment,
}: {
  hunks: Hunk[]
  commentMap: Map<string, LineComment[]>
  interactive: boolean
  onLineComment?: DiffViewProps['onLineComment']
}) {
  return (
    <div className="diff-unified">
      {hunks.map((h, hi) => (
        <div key={hi} className="diff-hunk-group">
          {h.lines.map((line, li) => (
            <DiffRow
              key={`${hi}-${li}-${line.oldNo ?? ''}-${line.newNo ?? ''}`}
              line={line}
              comments={commentMap.get(lineAnchor(line))}
              interactive={interactive}
              onLineComment={onLineComment}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function SideBySide({
  hunks,
  commentMap,
  interactive,
  onLineComment,
}: {
  hunks: Hunk[]
  commentMap: Map<string, LineComment[]>
  interactive: boolean
  onLineComment?: DiffViewProps['onLineComment']
}) {
  return (
    <div className="diff-split">
      {hunks.map((h, hi) => {
        // Split lines into left (old) and right (new) columns
        const left: DiffLine[] = []
        const right: DiffLine[] = []
        for (const line of h.lines) {
          if (line.type === 'hunk') continue
          if (line.type === 'add') {
            left.push({ type: 'ctx', oldNo: null, newNo: null, content: '', file: line.file })
            right.push(line)
          } else if (line.type === 'del') {
            left.push(line)
            right.push({ type: 'ctx', oldNo: null, newNo: null, content: '', file: line.file })
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
                  <DiffRow
                    key={`${hi}-l-${li}-${line.oldNo ?? ''}`}
                    line={line}
                    comments={commentMap.get(lineAnchor(line))}
                    interactive={interactive}
                    onLineComment={onLineComment}
                  />
                ))}
              </div>
              <div className="diff-split-col">
                {right.map((line, li) => (
                  <DiffRow
                    key={`${hi}-r-${li}-${line.newNo ?? ''}`}
                    line={line}
                    comments={commentMap.get(lineAnchor(line))}
                    interactive={interactive}
                    onLineComment={onLineComment}
                  />
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
