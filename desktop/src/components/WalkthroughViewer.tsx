import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getArtifact } from '../runtime/client'
import type { ArtifactSummary } from '../runtime/types'
import { parseWalkthrough, buildStepComment, type WalkthroughDocument, type WalkthroughStep } from '../lib/walkthrough'

// 付费版 v1 · T1/T3 — 运行走查回放查看器。
// 数据源是 walkthrough-recorder hook 落的 walkthrough 工件（JSON：步骤时间线 +
// 每步截图 artifact id + UI diff 摘要）。查看器做三件事：步骤时间线、截图
// 上一步/下一步翻页（近似录像回放）、步骤级评论 → 续跑修正（T3 回炉闭环）。

export function WalkthroughViewer({
  sessionId,
  artifact,
  isPro,
  onSteer,
  sessionRunning,
}: {
  sessionId: string
  artifact: ArtifactSummary
  isPro: boolean
  /** 步骤评论回炉：文本经 steer/新 turn 注入同一会话（T3）。 */
  onSteer?: (text: string) => void
  sessionRunning?: boolean
}) {
  const { t } = useTranslation('review')
  const [doc, setDoc] = useState<WalkthroughDocument | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [comment, setComment] = useState('')
  const [commentSent, setCommentSent] = useState(false)
  // 截图缓存：artifactId → base64（翻页回退不重复拉取）。
  const [shots, setShots] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setLoadError(false)
    setCursor(0)
    getArtifact(sessionId, artifact.id)
      .then((res) => {
        if (cancelled) return
        const parsed = parseWalkthrough(res.raw)
        if (parsed) setDoc(parsed)
        else setLoadError(true)
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [sessionId, artifact.id])

  const step = doc?.steps[cursor]

  // 当前步截图按需加载（Pro 才拉，免费版不浪费请求）。
  const shotId = isPro ? step?.screenshotArtifactId : undefined
  useEffect(() => {
    if (!shotId || shots[shotId] !== undefined) return
    let cancelled = false
    getArtifact(sessionId, shotId)
      .then((res) => { if (!cancelled) setShots((m) => ({ ...m, [shotId]: res.raw })) })
      .catch(() => { if (!cancelled) setShots((m) => ({ ...m, [shotId]: '' })) })
    return () => { cancelled = true }
  }, [shotId, sessionId, shots])

  const stepLabel = useCallback((s: WalkthroughStep) =>
    `${s.index}. ${s.success ? '✓' : '✗'} ${s.action}${s.app ? ` @ ${s.app}` : ''}`, [])

  const sendComment = useCallback(() => {
    if (!step || !comment.trim() || !onSteer) return
    // 带步骤锚点的续跑修正："步骤 N（action @ app）：<评论>"
    const anchor = t('walkthrough.commentAnchor', {
      n: step.index,
      action: step.action,
      app: step.app || '—',
    })
    onSteer(buildStepComment(anchor, comment))
    setComment('')
    setCommentSent(true)
    setTimeout(() => setCommentSent(false), 3000)
  }, [step, comment, onSteer, t])

  const summaryLine = useMemo(() => {
    if (!doc) return ''
    const parts = [
      t('walkthrough.stepsCount', { n: doc.summary.totalSteps }),
      doc.summary.failedSteps > 0 ? t('walkthrough.failedCount', { n: doc.summary.failedSteps }) : null,
      doc.summary.apps.length > 0 ? doc.summary.apps.join(', ') : null,
    ].filter(Boolean)
    return parts.join(' · ')
  }, [doc, t])

  // ── Pro gate：免费版显示升级引导，不渲染回放 ──
  if (!isPro) {
    return (
      <div className="walkthrough-upsell empty" style={{ padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 8 }} aria-hidden>🔒</div>
        <p style={{ marginBottom: 4 }}>{t('walkthrough.proTitle')}</p>
        <p className="meta">{t('walkthrough.proPitch')}</p>
      </div>
    )
  }

  if (loadError) return <div className="empty sm">{t('walkthrough.loadError')}</div>
  if (!doc) return <div className="empty sm">{t('walkthrough.loading')}</div>
  if (doc.steps.length === 0) return <div className="empty sm">{t('walkthrough.empty')}</div>

  const shot = shotId ? shots[shotId] : undefined

  return (
    <div className="walkthrough-viewer" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8, padding: 8 }}>
      {/* 摘要头 */}
      <div className="meta">
        {summaryLine}
        {doc.summary.halted && <span className="warn"> · {t('walkthrough.halted')}</span>}
      </div>

      {/* 步骤时间线 */}
      <div className="walkthrough-timeline" style={{ maxHeight: '30%', overflowY: 'auto', flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 6 }}>
        {doc.steps.map((s, i) => (
          <button
            key={s.index}
            className="walkthrough-step-row"
            onClick={() => setCursor(i)}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px',
              background: i === cursor ? 'var(--panel-2, rgba(127,127,127,0.15))' : 'transparent',
              border: 'none', cursor: 'pointer',
              color: s.success ? 'inherit' : 'var(--warn, #e5534b)',
              fontSize: 12,
            }}
            title={s.detail ?? ''}
          >
            {stepLabel(s)}
          </button>
        ))}
      </div>

      {/* 当前步骤详情 + 截图翻页 */}
      {step && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn ghost sm" disabled={cursor === 0} onClick={() => setCursor((c) => Math.max(0, c - 1))}>
              ‹ {t('walkthrough.prev')}
            </button>
            <span className="meta" style={{ flex: 1, textAlign: 'center' }}>
              {t('walkthrough.stepOf', { n: step.index, total: doc.steps.length })}
            </span>
            <button className="btn ghost sm" disabled={cursor >= doc.steps.length - 1} onClick={() => setCursor((c) => Math.min(doc.steps.length - 1, c + 1))}>
              {t('walkthrough.next')} ›
            </button>
          </div>

          <div style={{ fontSize: 13, fontWeight: 600 }}>{stepLabel(step)}</div>
          {step.detail && <div className="meta" style={{ wordBreak: 'break-all' }}>{step.detail}</div>}
          {step.uiDiff && (
            <pre className="meta" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, padding: 6 }}>
              {step.uiDiff}
            </pre>
          )}
          {step.errorNote && <div className="meta warn">{step.errorNote}</div>}

          {step.screenshotArtifactId ? (
            shot === undefined ? (
              <div className="empty sm">{t('walkthrough.shotLoading')}</div>
            ) : shot === '' ? (
              <div className="empty sm">{t('walkthrough.shotMissing')}</div>
            ) : (
              <img
                src={`data:image/png;base64,${shot}`}
                alt={stepLabel(step)}
                style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid var(--border)' }}
              />
            )
          ) : (
            <div className="meta">{t('walkthrough.noShot')}</div>
          )}

          {/* T3 — 步骤评论 → 续跑修正 */}
          {onSteer && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <textarea
                value={comment}
                placeholder={t('walkthrough.commentPlaceholder', { n: step.index })}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                style={{ flex: 1, fontSize: 12 }}
              />
              <button className="btn sm" disabled={!comment.trim()} onClick={sendComment}>
                {sessionRunning ? t('walkthrough.steer') : t('walkthrough.resume')}
              </button>
            </div>
          )}
          {commentSent && <div className="meta">{t('walkthrough.commentSent')}</div>}
        </div>
      )}
    </div>
  )
}
