import { useEffect, useMemo, useState } from 'react'
import { usePlans, usePlan, useApprovePlan, useRejectPlan } from '../state/queries'
import { Markdown } from '../components/Markdown'
import type { PlanStatus } from '../runtime/types'

const STATUS_LABEL: Record<PlanStatus, string> = {
  submitted: '待审',
  approved: '已批准',
  executed: '已执行',
  rejected: '已拒绝',
}

/**
 * Plan column (Cursor 3.0 "Build" surface). Lists this session's plans, renders
 * the selected plan's markdown, and exposes Build (approve → execute) / Reject
 * (with feedback) / Copy. Auto-selects the newest submitted plan.
 */
export function PlanPanel(props: {
  sessionId: string | null
  planRev: number
  latestPlanSlug?: string
}) {
  const { sessionId, planRev, latestPlanSlug } = props
  const plans = usePlans(sessionId, planRev)
  const [selected, setSelected] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [copied, setCopied] = useState(false)

  const approve = useApprovePlan()
  const reject = useRejectPlan()

  const list = plans.data ?? []

  // Auto-select: prefer the freshly submitted plan, else the newest, when no
  // valid selection is held.
  const selectedExists = selected != null && list.some((p) => p.slug === selected)
  useEffect(() => {
    if (selectedExists) return
    const next = (latestPlanSlug && list.some((p) => p.slug === latestPlanSlug))
      ? latestPlanSlug
      : list[0]?.slug ?? null
    setSelected(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestPlanSlug, list.length, selectedExists])

  const doc = usePlan(sessionId, selected, planRev)
  const current = useMemo(() => list.find((p) => p.slug === selected) ?? null, [list, selected])

  const onBuild = () => {
    if (!sessionId || !selected) return
    approve.mutate({ id: sessionId, slug: selected })
  }
  const onReject = () => {
    if (!sessionId || !selected) return
    reject.mutate(
      { id: sessionId, slug: selected, comment: comment.trim() || undefined },
      { onSuccess: () => { setRejecting(false); setComment('') } },
    )
  }
  const onCopy = async () => {
    if (!doc.data?.content) return
    try {
      await navigator.clipboard.writeText(doc.data.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard may be unavailable in some contexts
    }
  }

  if (!sessionId) {
    return <div className="empty sm">选择一个线程查看方案</div>
  }

  return (
    <div className="plan-panel">
      <div className="plan-list">
        {list.length === 0 && (
          <div className="empty sm">
            还没有方案。切到 Plan 模式后描述目标，agent 会只读探索并产出方案。
          </div>
        )}
        {list.map((p) => (
          <button
            key={p.slug}
            className={`plan-item ${p.slug === selected ? 'active' : ''}`}
            onClick={() => { setSelected(p.slug); setRejecting(false) }}
          >
            <span className={`plan-badge st-${p.status}`}>{STATUS_LABEL[p.status]}</span>
            <span className="plan-title">{p.title}</span>
          </button>
        ))}
      </div>

      {current && (
        <div className="plan-detail">
          <div className="plan-doc">
            {doc.isLoading && <div className="empty sm">加载方案…</div>}
            {doc.data?.content && <Markdown source={doc.data.content} />}
          </div>

          {rejecting ? (
            <div className="plan-reject">
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="（可选）说明需要怎么修订，agent 会据此重做方案"
                autoFocus
              />
              <div className="plan-actions">
                <button className="btn ghost sm" onClick={() => setRejecting(false)}>取消</button>
                <button className="btn sm" disabled={reject.isPending} onClick={onReject}>
                  {reject.isPending ? '提交中…' : '确认拒绝'}
                </button>
              </div>
            </div>
          ) : (
            <div className="plan-actions">
              <button className="btn ghost sm" onClick={onCopy}>{copied ? '已复制' : '复制'}</button>
              <button className="btn ghost sm" onClick={() => setRejecting(true)}>拒绝</button>
              <button
                className="btn sm primary"
                disabled={approve.isPending || current.status === 'approved' || current.status === 'executed'}
                onClick={onBuild}
                title="批准并执行此方案"
              >
                {approve.isPending ? '启动中…'
                  : current.status === 'approved' || current.status === 'executed' ? '已批准'
                  : 'Build'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
