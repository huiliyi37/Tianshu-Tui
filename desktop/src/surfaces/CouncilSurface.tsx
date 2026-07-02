import { useMemo, useState } from 'react'
import { useUiState } from '../state/store'
import { useArtifacts, useConveneCouncil, useDomains, useSessions, useSetDomain } from '../state/queries'
import type { DomainEntry } from '../runtime/types'
import { Check, Users, ScrollText, Sparkles } from 'lucide-react'

export function CouncilSurface() {
  const ui = useUiState()
  const sessionId = ui.activeSessionId
  const sessions = useSessions()
  const session = sessions.data?.find((s) => s.id === sessionId) ?? null
  const domains = useDomains(sessionId)
  const artifacts = useArtifacts(sessionId, 0)
  const convene = useConveneCouncil()
  const setDomain = useSetDomain()
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [rounds, setRounds] = useState<number>(1)

  const planArtifacts = useMemo(() => {
    return (artifacts.data ?? []).filter((a) => a.kind === 'plan' || a.kind === 'task-list')
  }, [artifacts.data])

  const latestCouncil = useMemo(() => {
    return (artifacts.data ?? []).find((a) => a.tool === 'council_convene')
  }, [artifacts.data])

  const isRunning = session?.status === 'running'
  const canConvene = !!sessionId && !isRunning && !!selectedArtifactId && !convene.isPending

  const handleConvene = () => {
    if (!canConvene || !selectedArtifactId) return
    convene.mutate({ id: sessionId, artifactId: selectedArtifactId, rounds })
  }

  const handlePickDomain = (key: string) => {
    if (!sessionId || key === 'auto') return
    setDomain.mutate({ id: sessionId, key })
  }

  return (
    <div className="surface-scroll">
      <div className="council-surface">
        <header className="council-header">
          <div>
            <h3><Sparkles size={18} /> 星域名册 · 议事会</h3>
            <p className="council-subtitle">
              {session
                ? `当前线程：${session.title ?? session.id.slice(0, 8)}`
                : '请先在左侧选择一个线程'}
            </p>
          </div>
          {session && (
            <span className={`council-status ${isRunning ? 'running' : 'idle'}`}>
              {isRunning ? '会话运行中' : '会话空闲'}
            </span>
          )}
        </header>

        {!sessionId && <div className="empty">请先选择一个线程。</div>}

        {sessionId && (
          <div className="council-layout">
            <section className="council-panel">
              <div className="council-panel-head">
                <Users size={16} />
                <h4>星域名册</h4>
              </div>
              {domains.isLoading && <div className="surface-loading">加载中…</div>}
              {domains.isError && <div className="meta warn">加载失败</div>}
              <div className="domain-grid">
                {(domains.data ?? []).map((d) => (
                  <DomainCard
                    key={d.key}
                    domain={d}
                    current={d.current}
                    onClick={() => handlePickDomain(d.key)}
                    busy={setDomain.isPending && d.current}
                  />
                ))}
              </div>
            </section>

            <aside className="council-side">
              <section className="council-panel">
                <div className="council-panel-head">
                  <ScrollText size={16} />
                  <h4>召集议事会</h4>
                </div>
                {isRunning ? (
                  <div className="council-hint warn">
                    当前会话正在运行，请等待本轮结束后再召集议事会。
                  </div>
                ) : (
                  <div className="council-form">
                    <label className="council-field">
                      <span>选择计划 artifact</span>
                      <select
                        value={selectedArtifactId ?? ''}
                        onChange={(e) => setSelectedArtifactId(e.target.value || null)}
                      >
                        <option value="">请选择…</option>
                        {planArtifacts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.target} ({a.kind})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="council-field">
                      <span>轮次</span>
                      <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
                        <option value={1}>单轮会诊</option>
                        <option value={2}>双轮辩论（有冲突时启用）</option>
                      </select>
                    </label>

                    <button
                      className="btn primary council-convene-btn"
                      onClick={handleConvene}
                      disabled={!canConvene}
                    >
                      {convene.isPending ? '召集中…' : '召集议事会'}
                    </button>

                    {convene.isError && (
                      <div className="council-hint err">
                        召集失败：{(convene.error as Error)?.message}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {latestCouncil && (
                <section className="council-panel">
                  <div className="council-panel-head">
                    <Check size={16} />
                    <h4>最新议事结果</h4>
                  </div>
                  <div className="council-result-card">
                    <div className="council-result-title">{latestCouncil.target}</div>
                    <div className="council-result-summary">{latestCouncil.summary}</div>
                  </div>
                </section>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}

function DomainCard({
  domain,
  current,
  onClick,
  busy,
}: {
  domain: DomainEntry
  current: boolean
  onClick: () => void
  busy: boolean
}) {
  const glyph = domain.uiPersona?.glyph ?? '✹'
  const accent = domain.uiPersona?.accent ?? 'primary'
  const disabled = busy || current
  return (
    <button
      type="button"
      className={`domain-card ${current ? 'current' : ''} accent-${accent}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={current}
    >
      <div className="domain-glyph" aria-hidden>{glyph}</div>
      <div className="domain-body">
        <div className="domain-name">{domain.key === 'auto' ? `${domain.name} · 天枢` : domain.name}</div>
        <div className="domain-motto">{domain.motto}</div>
        <div className="domain-meta">{domain.meta}</div>
        <div className="domain-essence">{domain.essence}</div>
      </div>
      {current && (
        <span className="domain-current">
          <Check size={12} /> 当前
        </span>
      )}
    </button>
  )
}
