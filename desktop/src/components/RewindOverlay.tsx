import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  getRewindPoints,
  rewindSession,
  getRollbackPreview,
  rollbackSession,
  getPreciseFilePreview,
  rewindFilesPrecise,
  type RewindPoint,
  type PreciseFileEntry,
} from '../runtime/client'

interface RewindOverlayProps {
  sessionId: string
  onClose: () => void
  onRewound: (prompt: string) => void
  /** Session is running — every server rewind/rollback path 409s while a turn
   *  is in flight, and rolling back files under an active writer is unsafe, so
   *  all actions are disabled with a hint. */
  isRunning?: boolean
  /** Fired after a code rollback succeeds so the host can refresh the working
   *  tree / Changes view (files changed on disk without a conversation event). */
  onCodeRolledBack?: () => void
}

/** Which restore a chosen point will perform. */
type RestoreMode = 'convo' | 'code' | 'both'

/** Rollback preview sub-state, mirrors ReviewPanel's RollbackSection. */
type PreviewState = 'idle' | 'loading' | 'previewed' | 'running'

/** Preview payload: precise (per-message, from FileHistory) or the coarse
 *  session checkpoint fallback (git-based, covers bash-driven changes too). */
type Preview =
  | { kind: 'precise'; files: PreciseFileEntry[] }
  | { kind: 'coarse'; text: string; token: string }

export function RewindOverlay({ sessionId, onClose, onRewound, isRunning, onCodeRolledBack }: RewindOverlayProps) {
  const [points, setPoints] = useState<RewindPoint[]>([])
  const [idx, setIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Two-phase flow: null = message list; a point = action chooser for it.
  const [chosen, setChosen] = useState<RewindPoint | null>(null)
  // Rollback preview (only for code-affecting modes).
  const [pendingMode, setPendingMode] = useState<Exclude<RestoreMode, 'convo'> | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pvState, setPvState] = useState<PreviewState>('idle')

  useEffect(() => {
    getRewindPoints(sessionId)
      .then(({ points }) => {
        setPoints(points)
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e.message ?? e))
        setLoading(false)
      })
  }, [sessionId])

  // ── Actions ──────────────────────────────────────────────────────

  const restoreConversation = async (point: RewindPoint) => {
    try {
      await rewindSession(sessionId, point.index, false)
      onRewound(point.content)
      onClose()
    } catch (e) {
      toast.error(`回滚对话失败：${String((e as Error).message ?? e)}`)
    }
  }

  const loadPreview = async (mode: Exclude<RestoreMode, 'convo'>) => {
    if (!chosen) return
    setPvState('loading')
    try {
      // Prefer precise per-message restore (FileHistory). Fall back to the
      // coarse session checkpoint when there's no per-edit history for this
      // boundary (e.g. rehydrated session, or only bash-driven changes).
      const pf = await getPreciseFilePreview(sessionId, chosen.index)
      if (pf.available && pf.files.length > 0) {
        setPreview({ kind: 'precise', files: pf.files })
        setPendingMode(mode)
        setPvState('previewed')
        return
      }
      const p = await getRollbackPreview(sessionId)
      if (!p.available || !p.text || !p.confirmationToken) {
        toast.info('当前没有可回滚的更改')
        setPvState('idle')
        return
      }
      setPreview({ kind: 'coarse', text: p.text, token: p.confirmationToken })
      setPendingMode(mode)
      setPvState('previewed')
    } catch (e) {
      toast.error(`加载回滚预览失败：${String((e as Error).message ?? e)}`)
      setPvState('idle')
    }
  }

  const confirmRollback = async () => {
    if (!preview || !chosen || !pendingMode) return
    setPvState('running')
    try {
      if (preview.kind === 'precise') {
        const r = await rewindFilesPrecise(sessionId, chosen.index)
        if (!r.success) {
          toast.error(r.error ?? '回滚未执行')
          setPvState('previewed')
          return
        }
        toast.success(`已恢复到此消息 · ${r.filesChanged.length} 个文件`)
      } else {
        const r = await rollbackSession(sessionId, preview.token)
        if (!r.success) {
          toast.error(r.error ?? '回滚未执行')
          setPvState('previewed')
          return
        }
        const parts = [`已恢复代码${r.hash ? `（${r.hash}）` : ''}`]
        if (r.skipped && r.skipped.length > 0) parts.push(`跳过 ${r.skipped.length} 个被占用文件`)
        toast.success(parts.join(' · '))
        if (r.unrevertable && r.unrevertable.length > 0) {
          toast.warning(`⚠️ 无法回滚的副作用：${r.unrevertable.join('; ')}`)
        }
      }
      onCodeRolledBack?.()
      // "对话 + 代码"：文件回滚后再截断对话到选中点。
      if (pendingMode === 'both') {
        await rewindSession(sessionId, chosen.index, false)
        onRewound(chosen.content)
      }
      onClose()
    } catch (e) {
      toast.error(`回滚失败：${String((e as Error).message ?? e)}`)
      setPvState('previewed')
    }
  }

  // Back out one layer: preview → chooser → list.
  const back = () => {
    if (pvState === 'running') return // in-flight rollback: ignore
    if (pvState === 'previewed') {
      setPreview(null)
      setPendingMode(null)
      setPvState('idle')
    } else if (chosen) {
      setChosen(null)
    } else {
      onClose()
    }
  }

  // ── Keyboard ─────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        back()
        return
      }
      // Preview layer: Enter confirms.
      if (pvState === 'previewed') {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (!isRunning) void confirmRollback()
        }
        return
      }
      // Chooser layer: no arrow nav; buttons only (Esc handled above).
      if (chosen) return
      // List layer.
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIdx((i) => Math.min(i + 1, points.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && points.length > 0) {
        e.preventDefault()
        setChosen(points[idx]!)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, idx, chosen, pvState, preview, pendingMode, isRunning])

  // ── Render ───────────────────────────────────────────────────────

  const busy = pvState === 'loading' || pvState === 'running'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rewind-panel" onClick={(e) => e.stopPropagation()}>
        <div className="rewind-header">⏪ Rewind — 选择要恢复到的消息</div>

        {loading && <div className="rewind-empty">Loading…</div>}
        {error && <div className="rewind-error">{error}</div>}
        {!loading && !error && points.length === 0 && (
          <div className="rewind-empty">No messages to rewind.</div>
        )}

        {/* Phase 1 — message list */}
        {!loading && !error && points.length > 0 && !chosen && (
          <>
            <div className="rewind-list">
              {points.map((p, i) => (
                <div
                  key={p.index}
                  className={`rewind-item ${i === idx ? 'selected' : ''}`}
                  onClick={() => setIdx(i)}
                  onDoubleClick={() => setChosen(p)}
                >
                  <span className="rewind-marker">{i === idx ? '▸' : ' '}</span>
                  <span className="rewind-text">
                    {p.content.length > 70 ? p.content.slice(0, 69) + '…' : p.content}
                  </span>
                </div>
              ))}
            </div>
            <div className="rewind-hint">↑↓ 选择 · Enter 选操作 · Esc 取消</div>
          </>
        )}

        {/* Phase 2 — action chooser for the selected point */}
        {chosen && (
          <div className="rewind-choose">
            <div className="rewind-chosen-preview" title={chosen.content}>
              {chosen.content.length > 90 ? chosen.content.slice(0, 89) + '…' : chosen.content}
            </div>

            {isRunning ? (
              <div className="rewind-error">运行中不可回滚，请先停止当前任务。</div>
            ) : (pvState === 'previewed' || pvState === 'running') && preview ? (
              // Preview + confirm (code / both)
              <div className="review-pending rollback-preview">
                <div className="rp-head">
                  <span className="kind warn">
                    {pendingMode === 'both' ? '确认恢复代码 + 截断对话' : '确认恢复代码'}
                  </span>
                  <span className="rewind-preview-tag">
                    {preview.kind === 'precise' ? '精确到此消息' : '整会话检查点'}
                  </span>
                </div>
                {preview.kind === 'precise' ? (
                  <ul className="rewind-file-list">
                    {preview.files.map((f) => (
                      <li key={f.path} className={`rewind-file rewind-file-${f.action}`}>
                        <span className="rewind-file-badge">{f.action === 'delete' ? '删除' : '还原'}</span>
                        <span className="rewind-file-path" title={f.path}>{f.path}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <pre className="rp-preview">{preview.text}</pre>
                )}
                <div className="rp-actions">
                  <button className="btn ghost sm" onClick={back} disabled={busy}>返回</button>
                  <button className="btn sm danger" onClick={() => void confirmRollback()} disabled={busy}>
                    {pvState === 'running' ? '恢复中…' : '确认恢复'}
                  </button>
                </div>
              </div>
            ) : (
              // Three-way choice
              <div className="rewind-actions">
                <button
                  className="rewind-action"
                  onClick={() => void restoreConversation(chosen)}
                  disabled={busy}
                >
                  <span className="rewind-action-title">仅恢复对话</span>
                  <span className="rewind-action-desc">截断对话到此消息，不改动文件</span>
                </button>
                <button
                  className="rewind-action"
                  onClick={() => void loadPreview('code')}
                  disabled={busy}
                >
                  <span className="rewind-action-title">仅恢复代码</span>
                  <span className="rewind-action-desc">把 agent 编辑的文件恢复到此消息时的状态，不改动对话</span>
                </button>
                <button
                  className="rewind-action"
                  onClick={() => void loadPreview('both')}
                  disabled={busy}
                >
                  <span className="rewind-action-title">对话 + 代码</span>
                  <span className="rewind-action-desc">截断对话到此消息，并把 agent 编辑的文件恢复到此刻</span>
                </button>
              </div>
            )}

            {!isRunning && pvState !== 'previewed' && (
              <div className="rewind-hint">
                {pvState === 'loading' ? '加载预览…' : 'Esc 返回列表'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
