import { useState } from 'react'
import { useGithubPrs, useGithubPr } from '../state/queries'
import { Markdown } from '../components/Markdown'

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

export function GithubPanel() {
  const prs = useGithubPrs()
  const [selected, setSelected] = useState<number | null>(null)
  const detail = useGithubPr(selected)

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

      {selected && detail.data && (
        <div className="gh-detail">
          <div className="gh-detail-header">
            <h4>#{detail.data.number} {detail.data.title}</h4>
            <a className="gh-link" href={detail.data.url} target="_blank" rel="noreferrer">GitHub ↗</a>
          </div>

          {detail.data.body && (
            <div className="gh-body">
              <Markdown source={detail.data.body} />
            </div>
          )}

          {detail.data.files.length > 0 && (
            <div className="gh-files">
              <h5>Changed Files · {detail.data.files.length}</h5>
              {detail.data.files.map((f) => (
                <div key={f.path} className="gh-file">
                  <span className="source-path">{f.path}</span>
                </div>
              ))}
            </div>
          )}

          {detail.data.comments.length > 0 && (
            <div className="gh-comments">
              <h5>Comments · {detail.data.comments.length}</h5>
              {detail.data.comments.map((c, i) => (
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
        </div>
      )}

      {selected && detail.isLoading && <div className="empty sm">加载 PR 详情…</div>}
    </div>
  )
}
