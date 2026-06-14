// Lightweight unified-diff renderer for diff-kind artifacts and edit approvals.
// Colors add/remove/hunk lines; falls back to plain text for non-diff content.
export function DiffView({ raw }: { raw: string }) {
  const lines = raw.split('\n')
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        let cls = 'diff-ctx'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-add'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-del'
        else if (line.startsWith('@@')) cls = 'diff-hunk'
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta'
        return (
          <div key={i} className={cls}>{line || ' '}</div>
        )
      })}
    </pre>
  )
}
