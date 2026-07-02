import { useMemo, useState } from 'react'
import { useFileDiff, useWorkingTree } from '../state/queries'
import { DiffView } from '../components/DiffView'
import type { LineComment, WorkingTreeFile } from '../runtime/types'

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
 * Working-tree changes relative to HEAD — the desktop "Changes" tab.
 *
 * Antigravity-2.0-style review: a single scrollable column with a sticky
 * summary bar (file count, total +/-, global single/double-column toggle) and
 * one collapsible card per changed file. Each card lazily fetches its own diff
 * the first time it is expanded (reusing GET /git/diff?path=), so opening the
 * tab never pulls 50 files' worth of diff at once. The first file is expanded by
 * default for an immediate "what changed" view.
 *
 * Host-agnostic: the diff is pure local git, so this works the same for repos
 * hosted on GitHub, gitee, self-hosted, or no remote at all.
 *
 * Degrades gracefully: non-git cwd shows "不是 git 仓库"; no changes shows the
 * empty state. Read-only (no stage/commit) — edits go through the agent.
 */
export function ChangesTab(props: {
  sessionId: string | null
  /** P1-3 — line-comment feedback loop: comments across files collect here and
   *  one click sends them as a structured prompt (running turn → steer). */
  onSendPrompt?: (text: string) => void
}) {
  const enabled = props.sessionId !== null
  const tree = useWorkingTree(enabled)
  const [sideBySide, setSideBySide] = useState(false)
  const [lineComments, setLineComments] = useState<LineComment[]>([])

  const addComment = (anchor: { file: string; oldLine?: number; newLine?: number }, text: string) => {
    setLineComments((prev) => [
      ...prev,
      { file: anchor.file, oldLine: anchor.oldLine, newLine: anchor.newLine, comment: text },
    ])
  }

  const sendComments = () => {
    if (!props.onSendPrompt || lineComments.length === 0) return
    const lines = lineComments.map(
      (c) => `- ${c.file}:${c.newLine ?? c.oldLine ?? '?'} — ${c.comment}`,
    )
    props.onSendPrompt(`请根据以下针对工作树 diff 的行级评论修改代码：\n\n${lines.join('\n')}`)
    setLineComments([])
  }

  const files = tree.data?.files ?? []
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, f) => {
          acc.add += f.additions
          acc.del += f.deletions
          return acc
        },
        { add: 0, del: 0 },
      ),
    [files],
  )

  if (!enabled) {
    return <div className="empty sm">无活动会话</div>
  }
  if (tree.isLoading) {
    return <div className="empty sm">加载中…</div>
  }
  if (tree.isError) {
    return <div className="empty sm">读取工作树失败</div>
  }
  if (tree.data && !tree.data.isRepo) {
    return <div className="empty sm">当前目录不是 git 仓库</div>
  }
  if (files.length === 0) {
    return <div className="empty sm">工作树无变更</div>
  }

  return (
    <div className="changes-overview">
      <div className="changes-summary">
        <span className="changes-summary-count">{files.length} 个文件变更</span>
        <span className="changes-summary-delta">
          {totals.add > 0 && <span className="add">+{totals.add}</span>}
          {totals.del > 0 && <span className="del">-{totals.del}</span>}
        </span>
        <button
          className={`diff-toggle ${sideBySide ? 'active' : ''}`}
          onClick={() => setSideBySide((v) => !v)}
          title="切换单列 / 双列视图"
        >
          {sideBySide ? '双列' : '单列'}
        </button>
        {props.onSendPrompt && lineComments.length > 0 && (
          <button
            className="btn sm changes-send-comments"
            onClick={sendComments}
            title="将行级评论汇总为一条 prompt 发送给智能体（运行中会作为引导插入）"
          >
            发送 {lineComments.length} 条评论
          </button>
        )}
      </div>
      <div className="changes-cards">
        {files.map((f, i) => (
          <FileDiffCard
            key={f.path}
            file={f}
            sideBySide={sideBySide}
            defaultOpen={i === 0}
            comments={props.onSendPrompt ? lineComments : undefined}
            onLineComment={props.onSendPrompt ? addComment : undefined}
          />
        ))}
      </div>
    </div>
  )
}

/** One collapsible per-file diff card. Fetches its diff only once expanded. */
function FileDiffCard(props: {
  file: WorkingTreeFile
  sideBySide: boolean
  defaultOpen: boolean
  comments?: LineComment[]
  onLineComment?: (anchor: { file: string; oldLine?: number; newLine?: number }, text: string) => void
}) {
  const { file, sideBySide, defaultOpen, comments, onLineComment } = props
  const [open, setOpen] = useState(defaultOpen)
  // null path → query disabled, so collapsed cards never fetch.
  const diff = useFileDiff(open ? file.path : null)

  return (
    <div className={`file-diff-card ${open ? 'open' : ''}`}>
      <button className="file-diff-card-head" onClick={() => setOpen((v) => !v)} title={file.path}>
        <span className="file-diff-chevron" aria-hidden>{open ? '▾' : '▸'}</span>
        <span className={`changes-status ${STATUS_CLASS[file.status]}`} aria-hidden>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="file-diff-path">{file.path}</span>
        <span className="file-diff-delta">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">-{file.deletions}</span>}
        </span>
      </button>
      {open && (
        <div className="file-diff-card-body">
          {diff.isLoading ? (
            <div className="empty sm">加载 diff…</div>
          ) : diff.isError ? (
            <div className="empty sm">读取 diff 失败</div>
          ) : !diff.data?.diff ? (
            <div className="empty sm muted">无文本差异（二进制文件）</div>
          ) : (
            <DiffView
              raw={diff.data.diff}
              sideBySide={sideBySide}
              hideToolbar
              comments={comments}
              onLineComment={onLineComment}
            />
          )}
        </div>
      )}
    </div>
  )
}
