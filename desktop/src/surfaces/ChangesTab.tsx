import { useState } from 'react'
import { useFileDiff, useWorkingTree } from '../state/queries'
import { DiffView } from '../components/DiffView'
import type { WorkingTreeFile } from '../runtime/types'

const STATUS_LABEL: Record<WorkingTreeFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
}

const STATUS_CLASS: Record<WorkingTreeFile['status'], string> = {
  modified: 'st-modified',
  added: 'st-added',
  deleted: 'st-deleted',
  renamed: 'st-renamed',
  untracked: 'st-untracked',
}

/**
 * Working-tree changes relative to HEAD — the desktop "Diff" tab.
 *
 * Two-pane layout: file list (left) + per-file unified diff (right, on demand).
 * The file list is polled (5s); the diff is fetched only when a file is selected
 * to avoid pulling 50 files' worth of diff at once. Renders the existing DiffView
 * component — no new diff-rendering logic.
 *
 * Degrades gracefully: non-git cwd shows "不是 git 仓库"; no changes shows the
 * empty state. This tab is read-only (no stage/commit) — per the "no IDE / edits
 * go through the agent" positioning.
 */
export function ChangesTab(props: { sessionId: string | null }) {
  const enabled = props.sessionId !== null
  const tree = useWorkingTree(enabled)
  const [selected, setSelected] = useState<string | null>(null)
  const diff = useFileDiff(selected)

  if (!enabled) {
    return <div className="empty sm">无活动会话</div>
  }
  if (tree.isLoading) {
    return <div className="empty sm">加载中…</div>
  }
  if (tree.isError) {
    return <div className="empty sm">读取工作树失败</div>
  }
  const data = tree.data
  if (data && !data.isRepo) {
    return <div className="empty sm">当前目录不是 git 仓库</div>
  }
  const files = data?.files ?? []
  if (files.length === 0) {
    return <div className="empty sm">工作树无变更</div>
  }

  return (
    <div className="changes-tab">
      <div className="changes-file-list">
        <div className="changes-file-count">{files.length} 个文件变更</div>
        {files.map((f) => (
          <button
            key={f.path}
            className={`changes-file ${selected === f.path ? 'selected' : ''}`}
            onClick={() => setSelected(f.path)}
            title={f.path}
          >
            <span className={`changes-status ${STATUS_CLASS[f.status]}`} aria-hidden>
              {STATUS_LABEL[f.status]}
            </span>
            <span className="changes-path">{shortPath(f.path)}</span>
            <span className="changes-delta">
              {f.additions > 0 && <span className="add">+{f.additions}</span>}
              {f.deletions > 0 && <span className="del">-{f.deletions}</span>}
            </span>
          </button>
        ))}
      </div>
      <div className="changes-diff-view">
        {selected === null ? (
          <div className="empty sm">选择左侧文件查看 diff</div>
        ) : diff.isLoading ? (
          <div className="empty sm">加载 diff…</div>
        ) : diff.isError ? (
          <div className="empty sm">读取 diff 失败</div>
        ) : !diff.data?.diff ? (
          <div className="empty sm">
            <div>{shortPath(selected)}</div>
            <div className="muted">无文本差异（二进制文件或未跟踪文件）</div>
          </div>
        ) : (
          <DiffView raw={diff.data.diff} />
        )}
      </div>
    </div>
  )
}

/** Show the last 2 path segments so long paths fit the narrow list. */
function shortPath(p: string): string {
  const parts = p.split('/')
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
}
