import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlans, usePlan, useApprovePlan, useRejectPlan } from '../state/queries'
import { Markdown } from '../components/Markdown'
import type { PlanModeState, PlanStatus, PlanSummary, PlanOption } from '../runtime/types'
import type { TodoStateItem } from '../runtime/types'
import { ChevronDown, ChevronUp, LayoutList, Search } from 'lucide-react'

/** Sentinel selection value for the live plan-mode draft (not a real slug). */
const DRAFT_SELECTION = '__draft__'

const STATUS_LABEL: Record<PlanStatus, string> = {
  submitted: '待审',
  approved: '已批准',
  executed: '已执行',
  rejected: '已拒绝',
}

type FilterMode = 'active' | 'archived' | 'all'

const FILTERS: { key: FilterMode; label: string }[] = [
  { key: 'active', label: '活动' },
  { key: 'archived', label: '已拒绝' },
  { key: 'all', label: '全部' },
]

function matchesFilter(p: PlanSummary, mode: FilterMode) {
  if (mode === 'all') return true
  if (mode === 'active') return p.status === 'submitted' || p.status === 'approved' || p.status === 'executed'
  return p.status === 'rejected'
}

/**
 * Plan column (Cursor 3.0 "Build" surface). Lists this session's plans, renders
 * the selected plan's markdown, and exposes Build / Reject / Copy.
 *
 * UX refresh:
 * - Plan selector is a thin horizontal chip strip so the document stays visible.
 * - Status filter defaults to "active" to reduce visual noise.
 * - A search box filters chips by title.
 * - "Expand list" toggles a compact vertical list for scanning many plans.
 * - Document area fills the remaining panel height and scrolls independently.
 */
export function PlanPanel(props: {
  sessionId: string | null
  planRev: number
  latestPlanSlug?: string
  todos?: TodoStateItem[]
  planMode?: PlanModeState
}) {
  const { sessionId, planRev, latestPlanSlug, planMode } = props
  const planning = planMode === 'planning'
  const plans = usePlans(sessionId, planRev, planning)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterMode>('active')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [copied, setCopied] = useState(false)
  const [selectedApproach, setSelectedApproach] = useState<string | null>(null)

  const approve = useApprovePlan()
  const reject = useRejectPlan()

  const all = plans.data?.plans ?? []
  // Live drafting document — only meaningful while the session is planning.
  const draft = planning ? plans.data?.draft ?? null : null
  const isDraftSelected = selected === DRAFT_SELECTION && !!draft
  // Sort: submitted first (newest), then approved/executed, rejected last.
  const STATUS_ORDER: Record<PlanStatus, number> = { submitted: 0, approved: 1, executed: 2, rejected: 3 }
  const sorted = useMemo(
    () => [...all].sort((a, b) => {
      const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      if (so !== 0) return so
      return b.createdAt - a.createdAt
    }),
    [all],
  )
  const filtered = useMemo(
    () =>
      sorted
        .filter((p) => matchesFilter(p, filter))
        .filter((p) => (query ? p.title.toLowerCase().includes(query.toLowerCase()) : true)),
    [sorted, filter, query],
  )

  // Live-draft surfacing: the moment a draft appears (plan mode entered),
  // select it so the growing document renders in real time — even when older
  // plans exist and would otherwise hold the selection. Transition-edge only:
  // if the user then clicks another plan chip, we don't force them back.
  const hadDraft = useRef(false)
  useEffect(() => {
    const has = !!draft
    if (has && !hadDraft.current) {
      setSelected(DRAFT_SELECTION)
      setRejecting(false)
    }
    hadDraft.current = has
  }, [!!draft]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fresh submission wins over a stale selection: when latestPlanSlug changes
  // (plan_submitted), jump to the new plan. Without this the previous
  // selection held forever and the new plan only surfaced after a tab switch
  // remounted the panel.
  const prevLatestSlug = useRef<string | undefined>(latestPlanSlug)
  useEffect(() => {
    if (latestPlanSlug && latestPlanSlug !== prevLatestSlug.current) {
      prevLatestSlug.current = latestPlanSlug
      setSelected(latestPlanSlug)
      setRejecting(false)
    }
  }, [latestPlanSlug])

  // Auto-select fallback: prefer the freshly submitted plan, else the newest,
  // when no valid selection is held. The draft sentinel counts as a valid
  // selection while a draft exists; when the draft vanishes (submit /
  // plan-mode exit), selection falls through to latestPlanSlug.
  const selectedExists =
    selected != null &&
    (filtered.some((p) => p.slug === selected) || (selected === DRAFT_SELECTION && !!draft))
  useEffect(() => {
    if (selectedExists) return
    // While drafting with nothing else to show, surface the growing document.
    if (draft) {
      setSelected(DRAFT_SELECTION)
      return
    }
    // Auto-select prefers the freshly submitted plan, else the newest non-rejected.
    // Never auto-select a rejected plan — user dismissed it, shouldn't resurface.
    const candidates = filter === 'active' ? sorted.filter((p) => matchesFilter(p, 'active')) : sorted
    const next =
      latestPlanSlug && candidates.some((p) => p.slug === latestPlanSlug)
        ? latestPlanSlug
        : candidates[0]?.slug ?? null
    setSelected(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestPlanSlug, sorted.length, filter, selectedExists, !!draft])

  const doc = usePlan(sessionId, selected === DRAFT_SELECTION ? null : selected, planRev)
  const current = useMemo(
    () => all.find((p) => p.slug === selected) ?? null,
    [all, selected],
  )
  const planOptions: PlanOption[] = useMemo(
    () => doc.data?.options ?? current?.options ?? [],
    [doc.data?.options, current?.options],
  )

  useEffect(() => {
    if (planOptions.length === 0) {
      setSelectedApproach(null)
      return
    }
    setSelectedApproach((prev) => {
      if (prev && planOptions.some(o => o.label === prev)) return prev
      const recommended = planOptions.find(o => /\(Recommended\)/i.test(o.label))
      return recommended?.label ?? planOptions[0]!.label
    })
  }, [selected, planOptions])

  const onBuild = () => {
    if (!sessionId || !selected) return
    approve.mutate({
      id: sessionId,
      slug: selected,
      selectedApproach: planOptions.length >= 2 ? selectedApproach ?? undefined : undefined,
    })
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
      <div className="plan-toolbar">
        <span className="plan-toolbar-title">方案</span>

        <div className="plan-filter">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={filter === f.key ? 'active' : ''}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="plan-search">
          <Search size={12} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="过滤方案"
          />
        </div>

        <button
          className="plan-expand-btn"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? '收起列表' : '展开列表'}
        >
          <LayoutList size={12} />
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {expanded ? (
        <div className="plan-list-compact">
          {draft && (
            <button
              className={`plan-item-row ${isDraftSelected ? 'active' : ''}`}
              onClick={() => { setSelected(DRAFT_SELECTION); setRejecting(false) }}
            >
              <span className="plan-badge st-drafting">起草中</span>
              <span className="plan-title">{draft.title ?? '正在起草方案…'}</span>
            </button>
          )}
          {filtered.length === 0 && !draft && (
            <div className="empty sm">{query ? '没有匹配的方案' : '该过滤条件下没有方案'}</div>
          )}
          {filtered.map((p) => (
            <button
              key={p.slug}
              className={`plan-item-row ${p.slug === selected ? 'active' : ''}`}
              onClick={() => { setSelected(p.slug); setRejecting(false) }}
            >
              <span className={`plan-badge st-${p.status}`}>{STATUS_LABEL[p.status]}</span>
              {p.modelTier === 'cheap' && (
                <span className="plan-badge st-cheap-model" title={`本计划由低阶模型（${p.model}）产出，建议复核`}>⚠ 低阶模型</span>
              )}
              <span className="plan-title">{p.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="plan-chips">
          {draft && (
            <button
              className={`plan-chip draft ${isDraftSelected ? 'active' : ''}`}
              onClick={() => { setSelected(DRAFT_SELECTION); setRejecting(false) }}
              title={draft.title ?? '正在起草方案…'}
            >
              <span className="plan-badge st-drafting">起草中</span>
              <span className="plan-chip-title">{draft.title ?? '正在起草方案…'}</span>
            </button>
          )}
          {filtered.length === 0 && !draft && (
            <div className="empty sm">{query ? '没有匹配的方案' : '该过滤条件下没有方案'}</div>
          )}
          {filtered.map((p) => (
            <button
              key={p.slug}
              className={`plan-chip ${p.slug === selected ? 'active' : ''}`}
              onClick={() => { setSelected(p.slug); setRejecting(false) }}
              title={p.modelTier === 'cheap' ? `${p.title} — 由低阶模型（${p.model}）产出，建议复核` : p.title}
            >
              <span className={`plan-badge st-${p.status}`}>{STATUS_LABEL[p.status]}</span>
              {p.modelTier === 'cheap' && <span className="plan-badge st-cheap-model">⚠</span>}
              <span className="plan-chip-title">{p.title}</span>
            </button>
          ))}
        </div>
      )}

      {isDraftSelected && draft && (
        <div className="plan-detail">
          <div className="plan-doc">
            {draft.content.trim()
              ? <Markdown source={draft.content} />
              : <div className="empty sm">正在起草方案…</div>}
          </div>
        </div>
      )}

      {current && (
        <div className="plan-detail">
          {current.modelTier === 'cheap' && current.status === 'submitted' && (
            <div className="plan-model-warning">
              ⚠ 本计划由低阶模型（{current.model}）产出，计划真实度可能不足，建议对关键改动点复核后再 Build。
            </div>
          )}
          <div className="plan-doc">
            {doc.isLoading && <div className="empty sm">加载方案…</div>}
            {doc.data?.content && <Markdown source={doc.data.content} />}
          </div>

          {planOptions.length >= 2 && current?.status === 'submitted' && !rejecting && (
            <div className="plan-options">
              <div className="plan-options-label">选择执行方案</div>
              {planOptions.map((opt) => (
                <label key={opt.label} className={`plan-option ${selectedApproach === opt.label ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="plan-option"
                    checked={selectedApproach === opt.label}
                    onChange={() => setSelectedApproach(opt.label)}
                  />
                  <span className="plan-option-body">
                    <span className="plan-option-label">{opt.label}</span>
                    {opt.description && <span className="plan-option-desc">{opt.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}

          {props.todos && props.todos.length > 0 && (
            <div className="plan-checklist">
              <div className="plan-checklist-header">
                执行进度
                <span className="plan-checklist-count">
                  {props.todos.filter(t => t.status === 'completed').length}/{props.todos.length}
                </span>
              </div>
              {props.todos.map((t) => (
                <div key={t.id} className={`plan-checklist-item st-${t.status}`}>
                  <span className="plan-checklist-glyph">
                    {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◌' : '○'}
                  </span>
                  <span className="plan-checklist-text">{t.content}</span>
                </div>
              ))}
            </div>
          )}

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
