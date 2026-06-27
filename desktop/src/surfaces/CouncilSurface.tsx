import { useMemo, useState } from 'react'
import { useUiState } from '../state/store'
import { useArtifacts, useConveneCouncil, useDomains, useSessions } from '../state/queries'
import type { DomainEntry } from '../runtime/types'

export function CouncilSurface() {
  const ui = useUiState()
  const sessionId = ui.activeSessionId
  const sessions = useSessions()
  const session = sessions.data?.find((s) => s.id === sessionId) ?? null
  const domains = useDomains(sessionId)
  const artifacts = useArtifacts(sessionId, 0)
  const convene = useConveneCouncil()
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

  return (
    <div className="surface-scroll">
      <div className="council-surface">
        <header className="council-header">
          <h3>星域名册 · 议事会</h3>
          {sessionId && session && (
            <span className="meta">
              当前线程：{session.title ?? session.id.slice(0, 8)}
            </span>
          )}
        </header>

        {!sessionId && <div className="empty">请先选择一个线程。</div>}

        {sessionId && (
          <>
            <section className="council-section">
              <h4>星域名册</h4>
              {domains.isLoading && <div className="surface-loading">加载中…</div>}
              {domains.isError && <div className="meta warn">加载失败</div>}
              <div className="domain-grid">
                {(domains.data ?? []).map((d) => (
                  <DomainCard key={d.key} domain={d} current={d.current} />
                ))}
              </div>
            </section>

            <section className="council-section">
              <h4>议事会</h4>
              {isRunning ? (
                <div className="meta warn">当前会话正在运行，请等待本轮结束后再召集议事会。</div>
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
                    className="btn primary"
                    onClick={handleConvene}
                    disabled={!canConvene}
                  >
                    {convene.isPending ? '召集中…' : '召集议事会'}
                  </button>

                  {convene.isError && (
                    <div className="meta warn">召集失败：{(convene.error as Error)?.message}</div>
                  )}
                </div>
              )}
            </section>

            {latestCouncil && (
              <section className="council-section">
                <h4>最新议事结果</h4>
                <div className="artifact-card">
                  <div className="artifact-title">{latestCouncil.target}</div>
                  <div className="artifact-summary">{latestCouncil.summary}</div>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function DomainCard({ domain, current }: { domain: DomainEntry; current: boolean }) {
  const glyph = domain.uiPersona?.glyph ?? '✹'
  const accent = domain.uiPersona?.accent ?? 'primary'
  return (
    <div className={`domain-card ${current ? 'current' : ''} accent-${accent}`}>
      <div className="domain-glyph">{glyph}</div>
      <div className="domain-name">{domain.name}</div>
      <div className="domain-motto">{domain.motto}</div>
      <div className="domain-meta">{domain.meta}</div>
      <div className="domain-essence">{domain.essence}</div>
      {current && <div className="domain-current">当前</div>}
    </div>
  )
}
