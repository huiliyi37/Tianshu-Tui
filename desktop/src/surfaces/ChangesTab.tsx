import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { qk, useFileDiff, useSessions, useWorkingTree } from '../state/queries'
import { commitSessionChanges, createSessionPr, mergeSessionBack } from '../runtime/client'
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
 * Working-tree changes relative to the session baseline — the desktop
 * "Changes" tab. Worktree sessions diff against the recorded task-start
 * commit (baselineHead) in their own worktree cwd, so committed work stays
 * visible; plain sessions fall back to HEAD in the shared cwd.
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
  const { t } = useTranslation('git')
  const enabled = props.sessionId !== null
  const tree = useWorkingTree(props.sessionId)
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
    props.onSendPrompt(t('changes.commentsPrompt', { comments: lines.join('\n') }))
    setLineComments([])
  }

  const sessions = useSessions()
  const session = sessions.data?.find((s) => s.id === props.sessionId)
  const busy = session?.status === 'running'
  const isWorktree = Boolean(session?.worktreeBranch)

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
    return <div className="empty sm">{t('changes.noSession')}</div>
  }
  if (tree.isLoading) {
    return <div className="empty sm">{t('changes.loading')}</div>
  }
  if (tree.isError) {
    return <div className="empty sm">{t('changes.treeFailed')}</div>
  }
  if (tree.data && !tree.data.isRepo) {
    return <div className="empty sm">{t('changes.notRepo')}</div>
  }
  if (files.length === 0) {
    return <div className="empty sm">{t('changes.empty')}</div>
  }

  return (
    <div className="changes-overview">
      <div className="changes-summary">
        <span className="changes-summary-count">{t('changes.filesChanged', { n: files.length })}</span>
        <span className="changes-summary-delta">
          {totals.add > 0 && <span className="add">+{totals.add}</span>}
          {totals.del > 0 && <span className="del">-{totals.del}</span>}
        </span>
        <button
          className={`diff-toggle ${sideBySide ? 'active' : ''}`}
          onClick={() => setSideBySide((v) => !v)}
          title={t('changes.toggleLayoutTitle')}
        >
          {sideBySide ? t('changes.split') : t('changes.unified')}
        </button>
        {props.onSendPrompt && lineComments.length > 0 && (
          <button
            className="btn sm changes-send-comments"
            onClick={sendComments}
            title={t('changes.sendCommentsTitle')}
          >
            {t('changes.sendComments', { n: lineComments.length })}
          </button>
        )}
      </div>
      <div className="changes-cards">
        {files.map((f, i) => (
          <FileDiffCard
            key={f.path}
            file={f}
            sessionId={props.sessionId}
            sideBySide={sideBySide}
            defaultOpen={i === 0}
            comments={props.onSendPrompt ? lineComments : undefined}
            onLineComment={props.onSendPrompt ? addComment : undefined}
          />
        ))}
      </div>
      {props.sessionId && (
        <LandingBar
          sessionId={props.sessionId}
          busy={busy}
          isWorktree={isWorktree}
          onSendPrompt={props.onSendPrompt}
        />
      )}
    </div>
  )
}

/**
 * Change-landing action bar — closes the "agent produced changes, now what?"
 * loop. Dual-channel: server-direct git (Commit / Merge back / Create PR,
 * fast, no agent turns) plus a "let the agent commit" prompt path that goes
 * through the agent's commit discipline. Direct git actions are disabled
 * while the agent is running to avoid racing its file writes.
 */
function LandingBar(props: {
  sessionId: string
  busy: boolean
  isWorktree: boolean
  onSendPrompt?: (text: string) => void
}) {
  const { sessionId, busy, isWorktree, onSendPrompt } = props
  const { t } = useTranslation('thread')
  const queryClient = useQueryClient()
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [pending, setPending] = useState<null | 'commit' | 'merge' | 'pr'>(null)
  const [notice, setNotice] = useState<null | { kind: 'ok' | 'err'; text: string; url?: string }>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.workingTree(sessionId) })
  }

  const runCommit = async () => {
    setPending('commit')
    setNotice(null)
    try {
      const r = await commitSessionChanges(sessionId, commitMsg.trim() || undefined)
      if (r.ok && r.nothingToCommit) setNotice({ kind: 'ok', text: t('landingNothingToCommit') })
      else if (r.ok) setNotice({ kind: 'ok', text: t('landingCommitted', { sha: r.sha?.slice(0, 8) ?? '' }) })
      else setNotice({ kind: 'err', text: t('landingFailed', { error: r.error ?? '' }) })
      if (r.ok) {
        setCommitOpen(false)
        setCommitMsg('')
        refresh()
      }
    } catch (e) {
      setNotice({ kind: 'err', text: t('landingFailed', { error: String(e) }) })
    } finally {
      setPending(null)
    }
  }

  const runMerge = async () => {
    setPending('merge')
    setNotice(null)
    try {
      const r = await mergeSessionBack(sessionId)
      if (r.ok && r.nothingToMerge) setNotice({ kind: 'ok', text: t('landingNothingToMerge') })
      else if (r.ok) setNotice({ kind: 'ok', text: t('landingMerged', { sha: r.sha?.slice(0, 8) ?? '' }) })
      else if (r.conflictFiles?.length) setNotice({ kind: 'err', text: t('landingConflicts', { files: r.conflictFiles.join(', ') }) })
      else setNotice({ kind: 'err', text: t('landingFailed', { error: r.error ?? '' }) })
      if (r.ok) refresh()
    } catch (e) {
      setNotice({ kind: 'err', text: t('landingFailed', { error: String(e) }) })
    } finally {
      setPending(null)
    }
  }

  const runPr = async () => {
    setPending('pr')
    setNotice(null)
    try {
      const r = await createSessionPr(sessionId)
      if (r.ok) setNotice({ kind: 'ok', text: t('landingPrCreated'), url: r.url })
      else setNotice({ kind: 'err', text: t('landingFailed', { error: r.error ?? '' }) })
    } catch (e) {
      setNotice({ kind: 'err', text: t('landingFailed', { error: String(e) }) })
    } finally {
      setPending(null)
    }
  }

  const askAgentCommit = () => {
    onSendPrompt?.(t('landingAgentCommitPrompt'))
    setNotice({ kind: 'ok', text: t('landingAgentCommitSent') })
  }

  const directDisabled = busy || pending !== null

  return (
    <div className="changes-landing">
      <div className="changes-landing-actions">
        <button
          className="btn sm"
          disabled={directDisabled}
          onClick={() => setCommitOpen((v) => !v)}
          title={busy ? t('landingBusy') : undefined}
        >
          {pending === 'commit' ? '…' : t('landingCommit')}
        </button>
        {onSendPrompt && (
          <button className="btn sm ghost" onClick={askAgentCommit}>
            {t('landingCommitAgent')}
          </button>
        )}
        {isWorktree && (
          <>
            <button
              className="btn sm"
              disabled={directDisabled}
              onClick={runMerge}
              title={busy ? t('landingBusy') : t('landingMergeBackHint')}
            >
              {pending === 'merge' ? '…' : t('landingMergeBack')}
            </button>
            <button
              className="btn sm"
              disabled={directDisabled}
              onClick={runPr}
              title={busy ? t('landingBusy') : t('landingCreatePrHint')}
            >
              {pending === 'pr' ? '…' : t('landingCreatePr')}
            </button>
          </>
        )}
      </div>
      {commitOpen && (
        <div className="changes-landing-commit">
          <input
            type="text"
            value={commitMsg}
            placeholder={t('landingCommitMsgPlaceholder')}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !directDisabled) void runCommit() }}
            autoFocus
          />
          <button className="btn sm primary" disabled={directDisabled} onClick={runCommit}>
            {t('landingConfirm')}
          </button>
        </div>
      )}
      {notice && (
        <div className={`changes-landing-notice ${notice.kind}`}>
          {notice.text}
          {notice.url && (
            <a href={notice.url} target="_blank" rel="noreferrer">{notice.url}</a>
          )}
        </div>
      )}
    </div>
  )
}

/** One collapsible per-file diff card. Fetches its diff only once expanded. */
function FileDiffCard(props: {
  file: WorkingTreeFile
  sessionId: string | null
  sideBySide: boolean
  defaultOpen: boolean
  comments?: LineComment[]
  onLineComment?: (anchor: { file: string; oldLine?: number; newLine?: number }, text: string) => void
}) {
  const { file, sessionId, sideBySide, defaultOpen, comments, onLineComment } = props
  const { t } = useTranslation('git')
  const [open, setOpen] = useState(defaultOpen)
  // null path → query disabled, so collapsed cards never fetch.
  const diff = useFileDiff(open ? file.path : null, sessionId)

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
            <div className="empty sm">{t('changes.loadingDiff')}</div>
          ) : diff.isError ? (
            <div className="empty sm">{t('changes.diffFailed')}</div>
          ) : !diff.data?.diff ? (
            <div className="empty sm muted">{t('changes.binaryNoDiff')}</div>
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
