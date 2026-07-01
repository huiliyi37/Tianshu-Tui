import { useMemo, useState } from 'react'
import { useGithubPrs, useGithubPr, useGithubPrDiff, useSubmitPrReview } from '../state/queries'
import { Markdown } from '../components/Markdown'
import { DiffView } from '../components/DiffView'
import { splitUnifiedDiffByFile, type FileDiff } from '../lib/split-diff'
import type { LineComment } from '../runtime/types'
import type { PrReviewInput } from '../runtime/client'

const STATE_GLYPH: Record<string, string> = {
  OPEN: '●',
  CLOSED: '○',
  MERGED: '◆',
}

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: '✓ Approved',
  CHANGES_REQUESTED: '✕ Changes',
  REVIEW_REQUIRED: '⏳ Review',
}

const VERDICTS: { event: PrReviewInput['event']; label: string }[] = [
  { event: 'COMMENT', label: '评论' },
  { event: 'APPROVE', label: '批准' },
  { event: 'REQUEST_CHANGES', label: '请求修改' },
]

export function GithubPanel() {
  const prs = useGithubPrs()
  const [selected, setSelected] = useState<number | null>(null)

  const list = prs.data?.prs ?? []
  const ghAvailable = prs.data?.ghAvailable ?? true

  if (!ghAvailable) {
    return (
      <div className="empty sm">
        <span className="empty-icon" aria-hidden>⑂</span>
        GitHub CLI 未安装或未认证。运行 <code>gh auth login</code> 后刷新。
      </div>
    )
  }

  return (
    <div className="gh-panel">
      <div className="gh-list">
        {list.length === 0 && <div className="empty sm">没有打开的 Pull Request</div>}
        {list.map((pr) => (
          <button
            key={pr.number}
            className={`gh-pr-item ${pr.number === selected ? 'active' : ''}`}
            onClick={() => setSelected(pr.number)}
          >
            <span className={`gh-state st-${pr.state.toLowerCase()}`}>{STATE_GLYPH[pr.state] ?? '·'}</span>
            <span className="gh-pr-num">#{pr.number}</span>
            <span className="gh-pr-title">{pr.title}</span>
            {pr.isDraft && <span className="gh-draft">Draft</span>}
            <span className="gh-pr-meta">
              {pr.author} · {pr.headRefName}
              {pr.reviewDecision ? ` · ${REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}` : ''}
            </span>
            <span className="gh-pr-diff">
              <span className="add">+{pr.additions}</span>
              <span className="del">-{pr.deletions}</span>
            </span>
          </button>
        ))}
      </div>

      {/* key={selected} remounts the detail so pending comments/verdict reset per PR. */}
      {selected != null && <PrReviewDetail key={selected} number={selected} />}
    </div>
  )
}

/**
 * PR detail + review surface for a single PR. Owns the pending review state
 * (local line comments + verdict + summary) so submitting once posts a single
 * GitHub review. Remounted (via key) when the selected PR changes, resetting
 * that pending state cleanly.
 */
function PrReviewDetail(props: { number: number }) {
  const { number } = props
  const detail = useGithubPr(number)
  const diff = useGithubPrDiff(number)
  const submit = useSubmitPrReview(number)

  const [lineComments, setLineComments] = useState<LineComment[]>([])
  const [summary, setSummary] = useState('')
  const [event, setEvent] = useState<PrReviewInput['event']>('COMMENT')
  const [sideBySide, setSideBySide] = useState(false)

  const files: FileDiff[] = useMemo(
    () => (diff.data ? splitUnifiedDiffByFile(diff.data) : []),
    [diff.data],
  )

  // Existing server-side inline comments (path + line) → LineComment for display.
  const serverInline: LineComment[] = useMemo(
    () =>
      (detail.data?.comments ?? [])
        .filter((c) => c.path && c.line != null)
        .map((c) => ({ file: c.path!, newLine: c.line!, comment: `${c.author}: ${c.body}` })),
    [detail.data],
  )

  const topLevelComments = (detail.data?.comments ?? []).filter((c) => !c.path)

  const addLineComment = (
    anchor: { file: string; oldLine?: number; newLine?: number },
    text: string,
  ) => {
    setLineComments((prev) => [
      ...prev,
      { file: anchor.file, oldLine: anchor.oldLine, newLine: anchor.newLine, comment: text },
    ])
  }

  const canSubmit =
    !submit.isPending && (event !== 'COMMENT' || summary.trim().length > 0 || lineComments.length > 0)

  const onSubmit = () => {
    if (!canSubmit) return
    submit.mutate(
      {
        event,
        body: summary,
        comments: lineComments.map((c) => ({
          path: c.file,
          oldLine: c.oldLine,
          newLine: c.newLine,
          body: c.comment,
        })),
      },
      {
        onSuccess: () => {
          setLineComments([])
          setSummary('')
          setEvent('COMMENT')
        },
      },
    )
  }

  if (detail.isLoading) return <div className="gh-detail"><div className="empty sm">加载 PR 详情…</div></div>
  if (!detail.data) return <div className="gh-detail"><div className="empty sm">读取 PR 详情失败</div></div>

  const pr = detail.data

  return (
    <div className="gh-detail">
      <div className="gh-detail-header">
        <h4>#{pr.number} {pr.title}</h4>
        <a className="gh-link" href={pr.url} target="_blank" rel="noreferrer">GitHub ↗</a>
      </div>

      {pr.body && (
        <div className="gh-body">
          <Markdown source={pr.body} />
        </div>
      )}

      <div className="gh-files">
        <div className="gh-files-head">
          <h5>Changed Files · {pr.files.length}</h5>
          <button
            className={`diff-toggle ${sideBySide ? 'active' : ''}`}
            onClick={() => setSideBySide((v) => !v)}
            title="切换单列 / 双列视图"
          >
            {sideBySide ? '双列' : '单列'}
          </button>
        </div>
        {diff.isLoading ? (
          <div className="empty sm">加载 diff…</div>
        ) : diff.isError ? (
          <div className="empty sm">读取 diff 失败</div>
        ) : files.length === 0 ? (
          <div className="empty sm muted">无文本差异</div>
        ) : (
          files.map((f, i) => {
            const fileComments = [
              ...serverInline.filter((c) => c.file === f.path),
              ...lineComments.filter((c) => c.file === f.path),
            ]
            return (
              <PrFileDiffCard
                key={f.path}
                file={f}
                comments={fileComments}
                sideBySide={sideBySide}
                defaultOpen={i === 0}
                onLineComment={addLineComment}
              />
            )
          })
        )}
      </div>

      {topLevelComments.length > 0 && (
        <div className="gh-comments">
          <h5>Comments · {topLevelComments.length}</h5>
          {topLevelComments.map((c, i) => (
            <div key={i} className="gh-comment">
              <div className="gh-comment-head">
                <strong>{c.author}</strong>
                <span className="meta">{new Date(c.createdAt).toLocaleDateString()}</span>
              </div>
              <div className="gh-comment-body">
                <Markdown source={c.body} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="gh-review-bar">
        <div className="gh-review-verdicts">
          {VERDICTS.map((v) => (
            <button
              key={v.event}
              className={`gh-verdict ${event === v.event ? 'active' : ''} v-${v.event.toLowerCase()}`}
              onClick={() => setEvent(v.event)}
            >
              {v.label}
            </button>
          ))}
          {lineComments.length > 0 && (
            <span className="gh-review-count">{lineComments.length} 条行内评论待提交</span>
          )}
        </div>
        <textarea
          className="gh-review-summary"
          placeholder="评审概要（可选，批准时可留空）…"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
        />
        {submit.isError && (
          <div className="gh-review-error">提交失败：{(submit.error as Error)?.message ?? '未知错误'}</div>
        )}
        <div className="gh-review-actions">
          {lineComments.length > 0 && (
            <button className="gh-review-clear" onClick={() => setLineComments([])} disabled={submit.isPending}>
              清空行内评论
            </button>
          )}
          <button className="gh-review-submit" onClick={onSubmit} disabled={!canSubmit}>
            {submit.isPending ? '提交中…' : '提交评审'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One collapsible per-file PR diff card. Renders DiffView only when expanded. */
function PrFileDiffCard(props: {
  file: FileDiff
  comments: LineComment[]
  sideBySide: boolean
  defaultOpen: boolean
  onLineComment: (anchor: { file: string; oldLine?: number; newLine?: number }, text: string) => void
}) {
  const { file, comments, sideBySide, defaultOpen, onLineComment } = props
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={`file-diff-card ${open ? 'open' : ''}`}>
      <button className="file-diff-card-head" onClick={() => setOpen((v) => !v)} title={file.path}>
        <span className="file-diff-chevron" aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="file-diff-path">{file.path}</span>
        {comments.length > 0 && <span className="file-diff-comment-badge">💬{comments.length}</span>}
      </button>
      {open && (
        <div className="file-diff-card-body">
          <DiffView
            raw={file.patch}
            comments={comments}
            onLineComment={onLineComment}
            sideBySide={sideBySide}
            hideToolbar
          />
        </div>
      )}
    </div>
  )
}
